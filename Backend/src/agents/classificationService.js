require("dotenv").config();
const crypto = require("crypto");
const { Groq } = require("groq-sdk");
const { Mistral } = require("@mistralai/mistralai");
const { bump, llmTotal } = require("../services/usageCounters");

// Safety ceiling: hard cap on total LLM calls per server session, so a runaway loop (webhook storm,
// debug-checkout spam) can't drain quota unattended. Not business logic — see .env.example.
const MAX_LLM_CALLS_PER_SESSION = Number(process.env.MAX_LLM_CALLS_PER_SESSION) || 100;

// In-memory result cache: the same (error_code, error_description) reclassifies identically, so in
// dev/testing loops we reuse the answer instead of re-asking any provider. Short TTL, reset on restart.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { value, expires }

// Hash of the failure signature — keeps the key bounded even for long error_descriptions.
function cacheKey({ error_code, error_description }) {
  return crypto.createHash("sha1").update(`${error_code}\n${error_description}`).digest("hex");
}

// Inference is ~0.15s, but a cold DNS+TCP+TLS setup to api.groq.com can take 3-8s on some
// networks. Budget for the handshake, not the model. Safe to raise: the webhook 200s before
// classify runs (webhook.js), so this never delays the Razorpay response.
const TIMEOUT_MS = 15000;

// Models are env-configurable per provider (defaults match .env.example).
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "ministral-8b-2512";

// Nemotron Ultra is a reasoning model at ~40 tok/s — give the primary a longer per-call budget than
// the fast fallbacks (TIMEOUT_MS). Classify runs after the webhook 200s (webhook.js), so waiting is free.
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30000;

const REASONS = [
  "insufficient_funds",
  "bank_decline",
  "card_expired",
  "card_invalid",
  "network_timeout",
  "domestic_only_restriction",
  "currency_mismatch",
  "authentication_failed",
  "limit_exceeded",
  "other",
];
const STRATEGIES = ["auto_retry", "payment_link", "alt_method"];

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

// Hard ceiling per provider so one hanging call can't stall the fallback chain.
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

// Hard invariant, enforced regardless of what any model/agent returned: an expired/invalid card
// can't succeed on retry, so never auto_retry it — downgrade to a payment_link the customer can fix.
// Exported so the strategy advisor reuses the SAME rule instead of reimplementing it.
function banCardAutoRetry(reason, strategy) {
  return (reason === "card_expired" || reason === "card_invalid") && strategy === "auto_retry"
    ? "payment_link"
    : strategy;
}

// JSON.parse + strict enum validation. Throws on anything malformed -> caller falls through.
function parseAndValidate(raw) {
  let text = String(raw).trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i); // defensive: strip fences if a model adds them
  if (fence) text = fence[1].trim();

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // Reasoning models (e.g. Nemotron) may emit chain-of-thought around the JSON. Grab the first
    // {...} object (greedy to the last brace = the whole object) and parse that.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON object in response");
    obj = JSON.parse(m[0]);
  }
  if (!REASONS.includes(obj.reason)) throw new Error(`invalid reason: ${obj.reason}`);
  if (!STRATEGIES.includes(obj.suggested_strategy)) throw new Error(`invalid strategy: ${obj.suggested_strategy}`);
  if (typeof obj.detail !== "string" || !obj.detail.trim()) throw new Error("missing/empty detail");

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const strategy = banCardAutoRetry(obj.reason, obj.suggested_strategy);

  return { reason: obj.reason, detail: obj.detail.trim(), confidence, suggested_strategy: strategy };
}

// OpenRouter is OpenAI-compatible — no SDK needed, just POST via global fetch (Node 18+).
async function callOpenRouter(apiKey, input, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1024, // reasoning-model headroom: reasoning tokens count against this
      reasoning: { effort: "low" }, // trim reasoning; OpenRouter normalizes/ignores per-model
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
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
}

async function callGroq(apiKey, input, model) {
  const client = new Groq({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    // gpt-oss is a reasoning model: reasoning tokens count against max_tokens. At the old 150 with
    // default effort, reasoning (~215 tok) starved the JSON entirely -> empty output -> json_validate_failed.
    // reasoning_effort:"low" trims reasoning (~59 tok here); 512 leaves headroom for input variance.
    // Both are ignored by non-reasoning models, so this stays safe if GROQ_MODEL is swapped back.
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

const SAFE_DEFAULT = {
  reason: "other",
  detail: "Automatic classification was unavailable; routed to a payment link as a safe fallback.",
  confidence: 0,
  suggested_strategy: "payment_link",
  provider_used: "fallback_default",
};

/**
 * Classify a failed payment via LLM with a 3-way fallback chain.
 * Never throws: on total failure it resolves to SAFE_DEFAULT so the webhook handler stays alive.
 * @param {{ error_code?: string, error_description?: string }} input
 * @returns {Promise<{ reason: string, confidence: number, suggested_strategy: string, provider_used: string }>}
 */
async function classifyFailure({ error_code, error_description } = {}) {
  const input = { error_code, error_description };

  // Cache first: an identical failure signature seen recently costs no API call.
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    console.log("[classify] cache hit, skipped API call");
    return { ...cached.value };
  }

  const chain = [
    { name: "openrouter", key: process.env.OPENROUTER_API_KEY, model: OPENROUTER_MODEL, call: callOpenRouter, timeout: OPENROUTER_TIMEOUT_MS },
    { name: "groq", key: process.env.GROQ_API_KEY, model: GROQ_MODEL, call: callGroq },
    { name: "mistral", key: process.env.MISTRAL_API_KEY, model: MISTRAL_MODEL, call: callMistral },
  ];

  for (const provider of chain) {
    if (!provider.key) {
      console.warn(`[classify] skipping ${provider.name}: no API key set`);
      continue;
    }
    // Session ceiling: once hit, stop calling providers entirely and fail safe.
    if (llmTotal() >= MAX_LLM_CALLS_PER_SESSION) {
      console.warn("[classify] session call limit reached, returning safe default");
      return { ...SAFE_DEFAULT };
    }
    const n = bump(provider.name);
    console.log(`[classify] ${provider.name} call #${n} this session`);
    try {
      const content = await withTimeout(provider.call(provider.key, input, provider.model), provider.timeout || TIMEOUT_MS, provider.name);
      const parsed = parseAndValidate(content);
      const result = { ...parsed, provider_used: provider.name };
      cache.set(key, { value: result, expires: Date.now() + CACHE_TTL_MS });
      return result;
    } catch (err) {
      console.error(`[classify] ${provider.name} failed: ${err.message}`);
    }
  }

  console.error("[classify] all providers failed — using safe default");
  return { ...SAFE_DEFAULT };
}

module.exports = { classifyFailure, cacheKey, parseAndValidate, banCardAutoRetry };
