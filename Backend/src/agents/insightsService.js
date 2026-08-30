require("dotenv").config();
const { Groq } = require("groq-sdk");
const { Mistral } = require("@mistralai/mistralai");
const { loadAggregate } = require("../routes/dashboard"); // reuse the dashboard's query+aggregate — do NOT requery separately
const { bump, llmTotal } = require("../services/usageCounters");

// Insights Agent: turns the dashboard's aggregate into a 2-3 sentence plain-English summary. Off the
// webhook critical path and low-stakes, so it always degrades to a numbers-only templated fallback.
//
// ponytail: the provider chain below is the same shape as classificationService/verifierService.
// Copied (not shared) because classificationService's callers are JSON-mode + per-provider tuned and
// on the critical path — not worth a risky shared-module refactor here. Upgrade path: extract an
// llmClient.js once someone's willing to refactor the classifier's tuned calls onto it too.
const MAX_LLM_CALLS_PER_SESSION = Number(process.env.MAX_LLM_CALLS_PER_SESSION) || 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — same order of magnitude as the dashboard's 5s poll * repeated loads
const TIMEOUT_MS = 15000;
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30000;
// Insights + Ask block a user-facing page load, so the slow openrouter (Nemotron) leg gets a much
// tighter timeout than classification's fire-and-forget 30s — fail over to groq/mistral fast instead
// of making the dashboard wait. Classification/verifier keep their own 30s chains (separate modules).
const INSIGHTS_OPENROUTER_TIMEOUT_MS = Number(process.env.INSIGHTS_OPENROUTER_TIMEOUT_MS) || 8000;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "ministral-8b-2512";

// "Ask the dashboard" Q&A bounds: reject anything longer than this rather than truncating (a huge
// pasted block is the cheap prompt-injection vector), and cap how many recent traces ride along in
// the prompt so a large payment history can't bloat it.
const MAX_QUESTION_LEN = 300;
const MAX_RECENT_IN_PROMPT = 30;

let cache = null; // { value: { summary, generated_at }, expires }
let inflight = null; // in-flight generateInsight() promise — coalesces concurrent callers (see below)

const SYSTEM_PROMPT = [
  "You are an analyst for a payment-failure recovery system.",
  "You are given the dashboard's aggregate JSON: funnel counts, money recovered vs lost, the most",
  "common failure reasons, and per-strategy recovery success rates.",
  "Write a concise 2-3 sentence plain-English summary for a business operator.",
  "Lead with money recovered vs lost and the recovery rate. Name the most common failure reason and",
  "say which recovery strategy is working best or worst. Use the ACTUAL numbers from the data.",
  "No preamble, no bullet points, no markdown — just the summary sentences.",
].join("\n");

// "Ask the dashboard" is a BOUNDED Q&A agent, not a chatbot: it may only answer from the data it's
// handed, and must decline anything it can't ground in that data (no generic payments/Razorpay
// knowledge). Keeping this explicit is what stops a judge's off-topic question from hallucinating.
const QA_SYSTEM_PROMPT = [
  "You are a data analyst for a payment-failure recovery dashboard.",
  "You are given the dashboard's own data: aggregate JSON (funnel counts, money recovered vs lost,",
  "failure-reason counts, per-strategy success rates) and a list of recent per-payment traces.",
  "Answer ONLY using the data provided. If the question can't be answered from this data, say so",
  "plainly — don't guess or use outside knowledge about payments/Razorpay in general.",
  "This is not a general assistant: if asked for anything outside this dashboard's data (e.g. which",
  "payment gateway is best, or general advice), reply in one sentence that you can only answer",
  "questions about this dashboard's data.",
  "Be concise (1-3 sentences), cite the actual numbers, and use no markdown or preamble.",
].join("\n");

// Format an amount with its currency for the templated fallback (₹12,400). Falls back to a plain
// string if Intl can't handle the currency code.
function fmtMoney(n, currency) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency || "INR"} ${Math.round(n)}`;
  }
}

// Compact the aggregate down to what the summary needs (drop the recent[] table — it's per-payment noise).
function compactStats({ funnel, money, by_reason, by_strategy }) {
  const total = money.recovered + money.lost;
  return {
    currency: money.currency,
    recovered: money.recovered,
    lost: money.lost,
    total_at_risk: total,
    recovery_rate_pct: total ? Math.round((money.recovered / total) * 100) : 0,
    funnel,
    top_failure_reasons: by_reason.slice(0, 5),
    strategy_success_rates: by_strategy.map((s) => ({
      strategy: s.strategy,
      attempted: s.attempted,
      succeeded: s.succeeded,
      success_rate_pct: Math.round(s.success_rate * 100),
    })),
  };
}

function buildUserPrompt(agg) {
  return `Dashboard data (amounts in ${agg.money.currency}):\n${JSON.stringify(compactStats(agg))}`;
}

// Project the recent[] traces down to the per-payment fields a question might reference (drops the
// verbose classifier detail / recovery notes). Capped at MAX_RECENT_IN_PROMPT so a long history
// can't blow up the prompt — the aggregate above already carries the full-history totals.
function compactRecent(recent) {
  return (recent || []).slice(0, MAX_RECENT_IN_PROMPT).map((r) => ({
    payment_id: r.razorpay_payment_id,
    amount: r.amount,
    status: r.status,
    failure_reason: r.failure_reason,
    strategy: r.recovery_strategy || r.suggested_strategy,
    recovery_status: r.recovery_status,
    recovered_amount: r.recovered_amount,
    provider: r.provider_used,
    created_at: r.created_at,
  }));
}

// The Q&A prompt: the SAME compacted aggregate generateInsight() uses, PLUS the recent[] traces (so
// per-payment questions are answerable), then the user's question. All of it is the app's own data.
function buildAskPrompt(agg, question) {
  const context = { ...compactStats(agg), recent: compactRecent(agg.recent) };
  return [
    `Dashboard data (amounts in ${agg.money.currency}):`,
    JSON.stringify(context),
    "",
    `Question: ${question}`,
  ].join("\n");
}

// Numbers-only fallback — never calls an LLM. Always returns something useful (requirement 4).
function templateSummary({ funnel, money, by_reason }) {
  const total = money.recovered + money.lost;
  const rate = total ? Math.round((money.recovered / total) * 100) : 0;
  const topReason = by_reason[0] ? by_reason[0].reason : "none";
  return `Recovered ${fmtMoney(money.recovered, money.currency)} of ${fmtMoney(total, money.currency)} (${rate}%). Top failure: ${topReason}.`;
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

// Free-text (NOT json_object) calls — this wants prose, not a schema. Slight temperature for readability.
async function callOpenRouter(apiKey, system, user, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 400, // reasoning-model headroom + ~3 sentences of prose
      reasoning: { effort: "low" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
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

async function callGroq(apiKey, system, user, model) {
  const client = new Groq({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
  const res = await client.chat.completions.create({
    model,
    temperature: 0.3,
    reasoning_effort: "low",
    max_tokens: 400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0].message.content;
}

async function callMistral(apiKey, system, user, model) {
  const client = new Mistral({ apiKey });
  const res = await client.chat.complete({
    model,
    temperature: 0.3,
    maxTokens: 300,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return extractText(res.choices[0].message);
}

// Run the fallback chain (openrouter → groq → mistral), same as classification/verifier. Each call
// counts toward MAX_LLM_CALLS_PER_SESSION. Throws if every provider fails — summarize() then templates.
// openrouterTimeoutMs (optional) overrides ONLY the slow openrouter (Nemotron) leg's timeout for this
// call; insights/ask pass the short INSIGHTS_OPENROUTER_TIMEOUT_MS so a stalled provider can't block a
// page load. Defaults to OPENROUTER_TIMEOUT_MS (30s). groq/mistral keep TIMEOUT_MS regardless.
async function callLLMChain(system, user, openrouterTimeoutMs) {
  const chain = [
    { name: "openrouter", key: process.env.OPENROUTER_API_KEY, model: OPENROUTER_MODEL, call: callOpenRouter, timeout: openrouterTimeoutMs || OPENROUTER_TIMEOUT_MS },
    { name: "groq", key: process.env.GROQ_API_KEY, model: GROQ_MODEL, call: callGroq },
    { name: "mistral", key: process.env.MISTRAL_API_KEY, model: MISTRAL_MODEL, call: callMistral },
  ];
  let lastErr = new Error("no provider available (no API keys set)");
  for (const p of chain) {
    if (!p.key) {
      console.warn(`[insights] skipping ${p.name}: no API key set`);
      continue;
    }
    if (llmTotal() >= MAX_LLM_CALLS_PER_SESSION) throw new Error("session LLM call limit reached");
    const n = bump(p.name);
    console.log(`[insights] ${p.name} call #${n} this session`);
    try {
      const text = await withTimeout(p.call(p.key, system, user, p.model), p.timeout || TIMEOUT_MS, p.name);
      const t = String(text || "").trim();
      if (t) return t;
      lastErr = new Error(`${p.name} returned empty`);
    } catch (err) {
      console.error(`[insights] ${p.name} failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// Never throws: LLM failure -> templated numbers-only summary.
async function summarize(agg, callLLM) {
  try {
    const text = await callLLM(SYSTEM_PROMPT, buildUserPrompt(agg), INSIGHTS_OPENROUTER_TIMEOUT_MS);
    const summary = String(text || "").replace(/\s+/g, " ").trim();
    if (!summary) throw new Error("empty summary");
    return summary;
  } catch (err) {
    console.error(`[insights] LLM summary failed, using templated fallback (${err.message})`);
    return templateSummary(agg);
  }
}

/**
 * Generate the dashboard's natural-language insight. Never throws. Cached in-memory for 5 minutes.
 * @param {{ loadAggregate?: () => Promise<object>, callLLM?: (system, user) => Promise<string> }} [deps] test seam
 * @returns {Promise<{ summary: string, generated_at: string }>}
 */
async function generateInsight(deps = {}) {
  if (cache && cache.expires > Date.now()) {
    console.log("[insights] cache hit");
    return cache.value;
  }
  // Single-flight. The summary call takes seconds; the cache is only written AFTER it resolves. Without
  // coalescing, every request arriving in that window (the dashboard's 5s poll, a StrictMode double-
  // mount, multiple tabs) sees the still-empty cache and fires its OWN provider call — a cache
  // stampede. Instead, the first caller owns the request and everyone else awaits the same promise.
  if (inflight) {
    console.log("[insights] cache miss (coalesced onto in-flight request)");
    return inflight;
  }
  console.log("[insights] cache miss");

  inflight = (async () => {
    const load = deps.loadAggregate || loadAggregate;
    const callLLM = deps.callLLM || callLLMChain;
    const generated_at = new Date().toISOString();

    let agg;
    try {
      agg = await load();
    } catch (err) {
      // Can't even read the data — return something, but don't cache so it retries next load.
      console.error(`[insights] data load failed, no summary: ${err.message}`);
      return { summary: "Insights are unavailable right now — dashboard data could not be loaded.", generated_at };
    }

    const value = { summary: await summarize(agg, callLLM), generated_at };
    cache = { value, expires: Date.now() + CACHE_TTL_MS };
    return value;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null; // release the slot whether we cached a value or hit the (uncached) load-failure path
  }
}

/**
 * Answer a bounded question over the dashboard's own aggregate + recent traces. Read-only, and NOT a
 * general chatbot — the system prompt keeps it grounded in the provided data. Never throws: bad input
 * and provider outages return a plain message instead of a fake answer. Reuses the same provider
 * chain as generateInsight (so the call counts toward MAX_LLM_CALLS_PER_SESSION via bump()), and
 * enforces that same ceiling as a per-session rate limit before spending a DB or LLM call.
 * @param {string} question
 * @param {{ loadAggregate?: () => Promise<object>, callLLM?: (system, user) => Promise<string> }} [deps] test seam
 * @returns {Promise<{ ok: boolean, status: number, answer?: string, error?: string }>}
 */
async function answerQuestion(question, deps = {}) {
  // Input handling FIRST — reject before touching a provider or the DB (no wasted API call).
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) return { ok: false, status: 400, error: "Please enter a question about the dashboard data." };
  if (q.length > MAX_QUESTION_LEN) {
    return { ok: false, status: 400, error: `Question is too long (max ${MAX_QUESTION_LEN} characters) — please shorten it.` };
  }
  // Per-session rate limit: reuse the existing LLM ceiling, don't build a new limiter. callLLMChain
  // re-checks this too, but short-circuiting here avoids even loading the aggregate when we're capped.
  if (llmTotal() >= MAX_LLM_CALLS_PER_SESSION) {
    return { ok: false, status: 429, error: "The AI usage limit for this session has been reached. Please try again later." };
  }

  const load = deps.loadAggregate || loadAggregate;
  const callLLM = deps.callLLM || callLLMChain;

  let agg;
  try {
    agg = await load();
  } catch (err) {
    console.error(`[insights] ask: data load failed: ${err.message}`);
    return { ok: false, status: 503, error: "The dashboard data couldn't be loaded, so I can't answer right now." };
  }

  try {
    const text = await callLLM(QA_SYSTEM_PROMPT, buildAskPrompt(agg, q), INSIGHTS_OPENROUTER_TIMEOUT_MS);
    const answer = String(text || "").replace(/\s+/g, " ").trim();
    if (!answer) throw new Error("empty answer");
    return { ok: true, status: 200, answer };
  } catch (err) {
    console.error(`[insights] ask: LLM failed (${err.message})`);
    return { ok: false, status: 503, error: "I couldn't reach the AI providers to answer that — please try again in a moment." };
  }
}

// Test-only: reset the module cache (and any in-flight request) between cases.
function _clearCache() {
  cache = null;
  inflight = null;
}

module.exports = { generateInsight, answerQuestion, templateSummary, buildUserPrompt, buildAskPrompt, _clearCache };
