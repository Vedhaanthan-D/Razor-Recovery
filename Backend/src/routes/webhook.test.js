// Run: node src/routes/webhook.test.js   (or: npm run test:webhook)  — pure mapping check, no DB/LLM.
// Loads the webhook module (which needs SUPABASE_* in .env to construct the client), then asserts
// the classify-result -> failure_classifications row mapping. This is the footgun: the table column
// is `failure_reason` while the service returns `reason`, and two columns (suggested_strategy,
// provider_used) only exist after the Phase 2 schema migration.
const assert = require("assert");
const { buildClassificationRow, parsePaymentLinkPaid, parseFailedPayment } = require("./webhook");

const result = {
  reason: "insufficient_funds",
  confidence: 0.9,
  suggested_strategy: "payment_link",
  provider_used: "mistral",
};
const row = buildClassificationRow("pay-uuid-1", result);

assert.strictEqual(row.payment_id, "pay-uuid-1", "payment_id passed through");
assert.strictEqual(row.failure_reason, "insufficient_funds", "reason -> failure_reason");
assert.strictEqual(row.confidence, 0.9, "confidence passed through");
assert.strictEqual(row.suggested_strategy, "payment_link", "suggested_strategy passed through");
assert.strictEqual(row.provider_used, "mistral", "provider_used passed through");
assert.deepStrictEqual(row.raw_llm_response, result, "full result stored as raw_llm_response");
assert.ok(!("reason" in row), "row must use failure_reason, never a bare `reason` column");

// --- payment_link.paid parsing (the recovery success path) ---
// Razorpay sends both entities; reference_id (on payment_link.entity) is rec_<razorpay_payment_id>,
// paid amount (on payment.entity) is paise → we store rupees.
const paidBody = {
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { reference_id: "rec_pay_ABC123", amount: 50000 } },
    payment: { entity: { id: "pay_XYZ", amount: 50000 } },
  },
};
const parsed = parsePaymentLinkPaid(paidBody);
assert.strictEqual(parsed.razorpayPaymentId, "pay_ABC123", "reference_id -> razorpay payment id (rec_ stripped)");
assert.strictEqual(parsed.recovered_amount, 500, "paise -> rupees for recovered_amount");
assert.strictEqual(
  parsePaymentLinkPaid({ payload: { payment_link: { entity: { reference_id: "someone_elses_link" } } } }),
  null,
  "non-rec_ reference_id is not ours -> null"
);
assert.strictEqual(parsePaymentLinkPaid({ payload: {} }), null, "missing payment_link entity -> null");

// --- payment.failed parsing (Phase 4 crash fix) ---
// A signed-but-malformed payload must resolve to null (→ 400), never throw on the nested access.
const goodEntity = { id: "pay_1", amount: 50000 };
assert.strictEqual(
  parseFailedPayment({ payload: { payment: { entity: goodEntity } } }),
  goodEntity,
  "well-formed payment.failed -> entity passed through"
);
assert.strictEqual(parseFailedPayment({ payload: {} }), null, "missing payment entity -> null (was the crash)");
assert.strictEqual(parseFailedPayment({ payload: { payment: { entity: null } } }), null, "null entity -> null");
assert.strictEqual(parseFailedPayment({ payload: { payment: { entity: {} } } }), null, "entity without id -> null");
assert.strictEqual(parseFailedPayment({}), null, "no payload at all -> null");

console.log("webhook.test.js: all assertions passed");
