require("dotenv").config();
const { Groq } = require("groq-sdk");
const { Mistral } = require("@mistralai/mistralai");
const { parseAndValidate } = require("./classificationService"); // reuse validation — do NOT duplicate
const { bump, llmTotal } = require("../services/usageCounters");

// Second-opinion classifier: only spends an API call when the primary classification is unsure.
// Reads the SAME env ceiling as classificationService so both share one budget (can't import the
// private const without touching that file, which the task forbids — re-reading the env stays in sync).
const MAX_LLM_CALLS_PER_SESSION = Number(process.env.MAX_LLM_CALLS_PER_SESSION) || 100;

const CONFIDENCE_FLOOR = 0.5; // primary at/above this is trusted → no verifier call
const CONFIDENCE_BOOST = 0.2; // added (capped at 1) when the verifier agrees

const TIMEOUT_MS = 15000;
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30000;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "ministral-8b-2512";

// ponytail: SYSTEM_PROMPT + the three provider callers are copied from classificationService because
// the task requires that file stay untouched and it doesn't export them. Only parseAndValidate is
// reused (it IS exported). Upgrade path: if the "untouched" constraint is ever lifted, export these
// from classificationService and delete the copies here.
const SYSTEM_PROMPT = [
  "You are a payment-failure classifier for a payment recovery system.",
  "Given a failed payment's error_code and error_description, classify the failure and pick a recovery strategy.",
  "Respond with ONLY a valid JSON object — no prose, no markdown, no code fences — of exactly this shape:",
  '{"reason": <insufficient_funds|bank_decline|card_expired|card_invalid|network_timeout|domestic_only_restriction|currency_mismatch|authentication_failed|limit_exceeded|other>,',
  ' "detail": <one short plain-language sentence naming the SPECIFIC cause, not just restating reason>,',
  ' "confidence": <number 0..1>,',
  ' "suggested_strategy": <auto_retry|payment_link|alt_method>}',
  'Example detail for domestic_only_restriction: "Business only accepts Indian-issued cards; customer\'s card was international."',
  "Strategy guidance:",
  "- card_expired / card_invalid: NEVER auto_retry (the same bad card cannot succeed) -> payment_link or alt_method.",
  "- network_timeout / bank_decline: transient -> auto_retry.",
  "- insufficient_funds / limit_exceeded: customer must act -> payment_link.",
  "- domestic_only_restriction / currency_mismatch: needs a different instrument -> alt_method.",
  "- authentication_failed: customer must re-authenticate -> payment_link.",
  "- other: payment_link.",
].join("\n");

function buildUserPrompt({ error_code, error_description }) {
  return `error_code: ${error_code || "unknown"}\nerror_description: ${error_description || "unknown"}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Mistral v2 message.content may be a string or an array of content chunks.
function extractText(message) {
  const c = message && message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x && x.text) || "").join("");
  return "";
}

async function callOpenRouter(apiKey, input, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1024,
      reasoning: { effort: "low" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openrouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
}

async function callGroq(apiKey, input, model) {
  const client = new Groq({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    reasoning_effort: "low",
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
  });
  return res.choices[0].message.content;
}

async function callMistral(apiKey, input, model) {
  const client = new Mistral({ apiKey });
  const res = await client.chat.complete({
    model,
    temperature: 0,
    maxTokens: 150,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
  });
  return extractText(res.choices[0].message);
}

// Provider registry. Keys are read lazily (closures) so tests can set env before a call and so a
// missing key is detected at pick-time, not module-load.
const PROVIDERS = {
  openrouter: { key: () => process.env.OPENROUTER_API_KEY, model: OPENROUTER_MODEL, call: callOpenRouter, timeout: OPENROUTER_TIMEOUT_MS },
  groq: { key: () => process.env.GROQ_API_KEY, model: GROQ_MODEL, call: callGroq },
  mistral: { key: () => process.env.MISTRAL_API_KEY, model: MISTRAL_MODEL, call: callMistral },
};

// Rotation from the spec: openrouter→groq, groq→mistral, mistral→openrouter. Never the primary's own.
const PREFERRED = { openrouter: "groq", groq: "mistral", mistral: "openrouter", fallback_default: "groq" };

// Pick a provider DIFFERENT from the primary's that actually has an API key. Falls back through the
// remaining providers so the verifier still runs when the preferred one isn't configured. null = no
// usable alternate (→ caller treats it as a failed check and keeps the primary).
function pickVerifierProvider(primaryProvider) {
  const order = [PREFERRED[primaryProvider] || "groq", "openrouter", "groq", "mistral"];
  for (const name of order) {
    if (name !== primaryProvider && PROVIDERS[name] && PROVIDERS[name].key()) return name;
  }
  return null;
}

// The real second opinion: ONE independent call to a different provider. Throws on any failure
// (no key / ceiling hit / timeout / bad JSON) so verifyClassification's catch keeps the primary.
async function defaultSecondOpinion(payment, primaryProvider) {
  const name = pickVerifierProvider(primaryProvider);
  if (!name) throw new Error("no alternate provider with an API key available");
  if (llmTotal() >= MAX_LLM_CALLS_PER_SESSION) throw new Error("session LLM call limit reached");

  const p = PROVIDERS[name];
  const n = bump(name); // counts toward MAX_LLM_CALLS_PER_SESSION, same as classificationService
  console.log(`[verifier] ${name} call #${n} this session (second opinion)`);
  const input = { error_code: payment.error_code, error_description: payment.error_description };
  const content = await withTimeout(p.call(p.key(), input, p.model), p.timeout || TIMEOUT_MS, name);
  return { ...parseAndValidate(content), provider_used: name };
}

/**
 * Second-opinion wrapper around a classifyFailure() result. Never throws.
 *   - primary.confidence >= 0.5  → return primary unchanged (no API call).
 *   - < 0.5 → one independent call to a DIFFERENT provider, then:
 *       agrees on reason → primary result, confidence boosted (+0.2, capped 1), verified:false.
 *       disagrees        → the VERIFIER's result (tie-breaker), verified:true.
 *       call failed      → primary unchanged, verified:false.
 * `verified` is true ONLY when the verifier's result became final (the outcome changed) — this is
 * exactly the "verifier changed the outcome" signal the dashboard surfaces.
 * @param {{ error_code?: string, error_description?: string }} payment
 * @param {{ reason: string, detail?: string, confidence: number, suggested_strategy: string, provider_used: string }} primaryResult
 * @param {{ secondOpinion?: (payment, primaryProvider) => Promise<object> }} [deps] test seam
 */
async function verifyClassification(payment, primaryResult, deps = {}) {
  const primary = primaryResult;
  const secondOpinion = deps.secondOpinion || defaultSecondOpinion;

  if (!(Number(primary.confidence) < CONFIDENCE_FLOOR)) {
    console.log(`[verifier] skipped, confidence sufficient (${primary.confidence})`);
    return { ...primary, verified: false };
  }

  let verifier;
  try {
    verifier = await secondOpinion(payment || {}, primary.provider_used);
  } catch (err) {
    console.error(`[verifier] check failed, using primary result as-is (${err.message})`);
    return { ...primary, verified: false };
  }

  if (verifier.reason === primary.reason) {
    const confidence = Math.min(1, Number(primary.confidence) + CONFIDENCE_BOOST);
    console.log(`[verifier] confirmed ${primary.reason}, confidence boosted to ${confidence}`);
    return { ...primary, confidence, verified: false };
  }

  console.log(`[verifier] overrode primary (${primary.reason} -> ${verifier.reason})`);
  return { ...verifier, verified: true };
}

module.exports = { verifyClassification, pickVerifierProvider, defaultSecondOpinion };
