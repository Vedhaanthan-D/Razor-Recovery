// Run: node src/services/usageCounters.test.js   (or: npm run test:usage)  — pure, no DB/API.
// Locks the counting + LLM-total aggregation that the session ceilings depend on.
const assert = require("assert");
const { bump, llmTotal, count, snapshot } = require("./usageCounters");

assert.strictEqual(bump("groq_key1"), 1, "first bump -> 1");
assert.strictEqual(bump("groq_key1"), 2, "second bump -> 2");
assert.strictEqual(count("groq_key1"), 2, "count reads without incrementing");
assert.strictEqual(count("groq_key1"), 2, "count is side-effect-free");

bump("mistral");
assert.strictEqual(llmTotal(), 3, "llmTotal sums groq_key1 + groq_key2 + mistral");

bump("razorpay");
assert.strictEqual(llmTotal(), 3, "razorpay excluded from the LLM ceiling");

const s = snapshot();
assert.strictEqual(s.groq_key1, 2, "snapshot reflects counts");
assert.strictEqual(s.razorpay, 1, "snapshot includes razorpay");
assert.ok(typeof s.session_started_at === "string" && s.session_started_at, "session_started_at set");

console.log("usageCounters.test.js: all assertions passed");
