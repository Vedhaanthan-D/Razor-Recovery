// Run: node src/services/recoveryService.test.js   (or: npm run test:recovery)  — pure, no DB/API.
// Checks the strategy → recovery_attempts row map, and the payment-link failover across accounts.
// Every classified payment must produce exactly one attempt, always starting at `pending`, and an
// unknown strategy must still yield a row (so the funnel can't silently lose a payment).
const assert = require("assert");
const { initialAttempt, createPaymentLinkNote } = require("./recoveryService");

for (const strategy of ["auto_retry", "payment_link", "alt_method"]) {
  const row = initialAttempt(strategy);
  assert.strictEqual(row.strategy, strategy, `${strategy}: strategy passed through`);
  assert.strictEqual(row.status, "pending", `${strategy}: starts pending`);
  assert.ok(row.notes && typeof row.notes === "string", `${strategy}: has a note`);
  assert.ok(!("recovered_amount" in row), `${strategy}: no recovered_amount until it resolves`);
}

// Unknown/absent strategy still tracked (never dropped).
const unknown = initialAttempt("teleport");
assert.strictEqual(unknown.status, "pending", "unknown: still pending");
assert.ok(unknown.strategy, "unknown: strategy label non-empty");

const missing = initialAttempt(undefined);
assert.strictEqual(missing.strategy, "unknown", "missing strategy → 'unknown' label");

// --- payment-link failover across accounts (createPaymentLinkNote) ---
// Injected fake clients — no real Razorpay call. Each .paymentLink.create resolves or throws per script.
function capError() {
  const e = new Error("cap");
  e.statusCode = 429;
  e.error = { code: "RATE_LIMIT_EXCEEDED", description: "test mode limit of 30 reached for payment_link" };
  return e;
}
const okClient = (label) => ({ label, client: { paymentLink: { create: async () => ({ id: "plink_" + label, short_url: "https://rzp.io/i/" + label }) } } });
const capClient = (label) => ({ label, client: { paymentLink: { create: async () => { throw capError(); } } } });

const payment = { id: "pay_test", amount: 50000, currency: "INR" };

(async () => {
  // primary at its 30-link cap → fails over to secondary, which succeeds
  let res = await createPaymentLinkNote(payment, [capClient("primary"), okClient("secondary")]);
  assert.strictEqual(res.ok, true, "failover: secondary create succeeds when primary is capped");
  assert.ok(res.note.includes("secondary"), "failover: note carries the secondary account's link");

  // every account at cap → ok:false, note surfaces the reason
  res = await createPaymentLinkNote(payment, [capClient("primary"), capClient("secondary")]);
  assert.strictEqual(res.ok, false, "all accounts capped → not ok");
  assert.ok(/limit of 30/.test(res.note), "capped note surfaces the 30-link limit");

  // primary succeeds → secondary is never consulted (don't burn the second account's quota)
  let secondaryCalled = false;
  const spySecondary = { label: "secondary", client: { paymentLink: { create: async () => { secondaryCalled = true; return { short_url: "x" }; } } } };
  res = await createPaymentLinkNote(payment, [okClient("primary"), spySecondary]);
  assert.strictEqual(res.ok, true, "primary success → ok");
  assert.strictEqual(secondaryCalled, false, "primary success → secondary not called");

  // no accounts configured → graceful skip, never throws
  res = await createPaymentLinkNote(payment, []);
  assert.strictEqual(res.ok, false, "no keys configured → not ok");

  console.log("recoveryService.test.js: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
