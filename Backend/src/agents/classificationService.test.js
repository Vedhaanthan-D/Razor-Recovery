// Run: node src/agents/classificationService.test.js   (or: npm run test:classify)
// Hits real LLM APIs — needs OPENROUTER_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY in .env.
// With no keys set it exercises the fallback chain all the way down to fallback_default.
const assert = require("assert");
const { classifyFailure, cacheKey, parseAndValidate } = require("./classificationService");
const { llmTotal } = require("../services/usageCounters");

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

const sample = {
  error_code: "BAD_REQUEST_ERROR",
  error_description: "payment failed because of insufficient funds in the customer account",
};

(async () => {
  console.log("input:", sample);
  const result = await classifyFailure(sample);
  console.log("result:", result);
  console.log("provider_used:", result.provider_used);

  assert.ok(REASONS.includes(result.reason), `reason in enum (got ${result.reason})`);
  assert.ok(STRATEGIES.includes(result.suggested_strategy), `strategy in enum (got ${result.suggested_strategy})`);
  assert.ok(result.confidence >= 0 && result.confidence <= 1, `confidence 0..1 (got ${result.confidence})`);
  assert.ok(typeof result.detail === "string" && result.detail.trim(), `detail non-empty (got ${JSON.stringify(result.detail)})`);
  assert.ok(typeof result.provider_used === "string" && result.provider_used, "provider_used set");

  // cacheKey: stable for the same signature, distinct for a different one.
  assert.strictEqual(cacheKey(sample), cacheKey(sample), "cacheKey stable for same input");
  assert.notStrictEqual(cacheKey(sample), cacheKey({ error_code: "X", error_description: "Y" }), "different input -> different key");

  // A second identical classify must be served from cache — no new provider call.
  const before = llmTotal();
  const again = await classifyFailure(sample);
  assert.deepStrictEqual(again, result, "cache hit returns the same result");
  assert.strictEqual(llmTotal(), before, "cache hit makes no API call");

  // parseAndValidate tolerates reasoning models: fenced JSON and prose-wrapped JSON both parse.
  const good = '{"reason":"insufficient_funds","detail":"Customer account balance was below the charge amount.","confidence":0.9,"suggested_strategy":"payment_link"}';
  assert.strictEqual(parseAndValidate("```json\n" + good + "\n```").reason, "insufficient_funds", "strips code fences");
  assert.strictEqual(parseAndValidate("Reasoning: the card was declined.\n" + good).reason, "insufficient_funds", "extracts JSON from prose");
  assert.throws(() => parseAndValidate("no json here"), "rejects non-JSON");

  // New taxonomy: the added enum values parse and carry a non-empty detail.
  const intl = parseAndValidate('{"reason":"domestic_only_restriction","detail":"Business only accepts Indian-issued cards; customer\'s card was international.","confidence":0.8,"suggested_strategy":"alt_method"}');
  assert.strictEqual(intl.reason, "domestic_only_restriction", "parses domestic_only_restriction");
  assert.ok(intl.detail.trim(), "domestic_only_restriction carries a non-empty detail");
  const cur = parseAndValidate('{"reason":"currency_mismatch","detail":"Card currency did not match the INR charge.","confidence":0.7,"suggested_strategy":"alt_method"}');
  assert.strictEqual(cur.reason, "currency_mismatch", "parses currency_mismatch");
  assert.ok(cur.detail.trim(), "currency_mismatch carries a non-empty detail");

  // detail is required: missing or blank falls through (throws) like any other validation failure.
  assert.throws(() => parseAndValidate('{"reason":"other","confidence":0.5,"suggested_strategy":"payment_link"}'), "rejects missing detail");
  assert.throws(() => parseAndValidate('{"reason":"other","detail":"   ","confidence":0.5,"suggested_strategy":"payment_link"}'), "rejects blank detail");

  // Hard invariant: a dead card can't succeed on retry, so auto_retry is downgraded to payment_link.
  const expired = parseAndValidate('{"reason":"card_expired","detail":"Card expiry date has passed.","confidence":0.95,"suggested_strategy":"auto_retry"}');
  assert.strictEqual(expired.suggested_strategy, "payment_link", "card_expired never auto_retry");
  const badcard = parseAndValidate('{"reason":"card_invalid","detail":"Card number failed the issuer check.","confidence":0.9,"suggested_strategy":"auto_retry"}');
  assert.strictEqual(badcard.suggested_strategy, "payment_link", "card_invalid never auto_retry");

  console.log("classificationService.test.js: all assertions passed");
})().catch((e) => {
  // classifyFailure is documented never to throw — if we land here, that contract broke.
  console.error("self-test crashed (classifyFailure should never throw):", e);
  process.exit(1);
});
