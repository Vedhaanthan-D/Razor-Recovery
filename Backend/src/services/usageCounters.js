// In-memory API-usage counters, reset on server restart. Shared by classificationService,
// recoveryService, and GET /api/debug/usage. Safety hygiene to protect free-tier quota during
// dev/demo — NOT persisted, NOT production-grade rate limiting.
const counts = { openrouter: 0, groq: 0, mistral: 0, razorpay: 0 };
const session_started_at = new Date().toISOString();

// Increment a provider's session counter and return the new count.
function bump(name) {
  counts[name] = (counts[name] || 0) + 1;
  return counts[name];
}

// Total LLM calls this session — every provider except razorpay shares MAX_LLM_CALLS_PER_SESSION.
// Sum all-but-razorpay so a renamed/added provider (openrouter, groq, …) counts automatically
// instead of silently escaping the ceiling when the chain changes.
function llmTotal() {
  return Object.entries(counts).reduce((t, [k, v]) => (k === "razorpay" ? t : t + v), 0);
}

// Read one counter without incrementing (used for the pre-call ceiling check).
function count(name) {
  return counts[name] || 0;
}

function snapshot() {
  return { ...counts, session_started_at };
}

module.exports = { bump, llmTotal, count, snapshot };
