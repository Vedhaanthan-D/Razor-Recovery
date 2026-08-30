// Run: node src/routes/dashboard.test.js   (or: npm run test:dashboard)  — pure, no DB.
// Exercises the funnel + money + breakdown math against a hand-built row set covering every state:
// recovered auto_retry, pending payment_link, classified-but-no-recovery, and unclassified.
const assert = require("assert");
const { aggregate } = require("./dashboard");

const rows = [
  {
    // recovered via auto_retry
    razorpay_payment_id: "pay_1", amount: 500, currency: "INR", status: "failed", created_at: "2026-08-21T10:00:00Z",
    failure_classifications: [{ failure_reason: "network_timeout", confidence: 0.9, suggested_strategy: "auto_retry", provider_used: "groq_key1" }],
    recovery_attempts: [{ strategy: "auto_retry", status: "success", recovered_amount: 500, notes: "ok" }],
  },
  {
    // classified, recovery attempted but still pending (payment_link) → counts as lost for now
    razorpay_payment_id: "pay_2", amount: 300, currency: "INR", status: "failed", created_at: "2026-08-21T09:00:00Z",
    failure_classifications: [{ failure_reason: "insufficient_funds", confidence: 0.8, suggested_strategy: "payment_link", provider_used: "mistral" }],
    recovery_attempts: [{ strategy: "payment_link", status: "pending", recovered_amount: null, notes: "link sent" }],
  },
  {
    // classified, no recovery attempt at all
    razorpay_payment_id: "pay_3", amount: 200, currency: "INR", status: "failed", created_at: "2026-08-21T08:00:00Z",
    failure_classifications: [{ failure_reason: "network_timeout", confidence: 0.7, suggested_strategy: "auto_retry", provider_used: "groq_key1" }],
    recovery_attempts: [],
  },
  {
    // unclassified (LLM never ran / failed to store)
    razorpay_payment_id: "pay_4", amount: 100, currency: "INR", status: "failed", created_at: "2026-08-21T07:00:00Z",
    failure_classifications: [],
    recovery_attempts: [],
  },
];

const r = aggregate(rows);

// Funnel
assert.strictEqual(r.funnel.failed, 4, "failed = all payments");
assert.strictEqual(r.funnel.classified, 3, "classified = have a classification");
assert.strictEqual(r.funnel.recovery_attempted, 2, "recovery_attempted = have >=1 attempt");
assert.strictEqual(r.funnel.recovered, 1, "recovered = have a successful attempt");

// Money: only pay_1 recovered (500). Lost = 300 + 200 + 100 = 600.
assert.strictEqual(r.money.recovered, 500, "recovered rupees");
assert.strictEqual(r.money.lost, 600, "lost rupees (everything without a success)");
assert.strictEqual(r.money.currency, "INR", "currency");

// By reason: network_timeout x2, insufficient_funds x1, sorted desc.
assert.deepStrictEqual(r.by_reason, [
  { reason: "network_timeout", count: 2 },
  { reason: "insufficient_funds", count: 1 },
], "reason breakdown sorted by count");

// By strategy: auto_retry attempted 1 / succeeded 1 (pay_3 had no attempt); payment_link 1 / 0.
const auto = r.by_strategy.find((s) => s.strategy === "auto_retry");
const link = r.by_strategy.find((s) => s.strategy === "payment_link");
assert.deepStrictEqual(auto, { strategy: "auto_retry", attempted: 1, succeeded: 1, success_rate: 1 }, "auto_retry stats");
assert.deepStrictEqual(link, { strategy: "payment_link", attempted: 1, succeeded: 0, success_rate: 0 }, "payment_link stats");

// Recent: one row per payment, recovered_amount only on the successful one.
assert.strictEqual(r.recent.length, 4, "recent has every payment");
assert.strictEqual(r.recent[0].recovered_amount, 500, "pay_1 shows recovered amount");
assert.strictEqual(r.recent[1].recovery_status, "pending", "pay_2 pending");
assert.strictEqual(r.recent[3].failure_reason, null, "pay_4 unclassified");

// Empty DB must not throw and must zero out cleanly.
const empty = aggregate([]);
assert.deepStrictEqual(empty.funnel, { failed: 0, classified: 0, recovery_attempted: 0, recovered: 0 }, "empty funnel");
assert.strictEqual(empty.money.lost, 0, "empty lost = 0");

// --- Phase 5: orchestrator escalation (a payment can now have MANY recovery_attempts rows) ---
// Step 5 decision, pinned here: the funnel counts recovery_attempted/recovered PER-PAYMENT (an
// escalated payment is one payment, not two), while the strategy table counts PER-ATTEMPT (raw — this
// is exactly where "payment_link attempted 12×, 5 of them escalated from auto_retry" must show).
const escalated = aggregate([
  {
    // escalated & recovered: auto_retry failed → payment_link paid. 2 attempts, 1 success.
    razorpay_payment_id: "pay_esc_ok", amount: 500, currency: "INR", status: "failed", created_at: "2026-08-23T10:00:00Z",
    failure_classifications: [{ failure_reason: "network_timeout", confidence: 0.9, suggested_strategy: "auto_retry", provider_used: "openrouter" }],
    recovery_attempts: [
      { strategy: "auto_retry", status: "failed", recovered_amount: null, notes: "retry failed" },
      { strategy: "payment_link", status: "success", recovered_amount: 500, notes: "link paid" },
    ],
  },
  {
    // full chain exhausted → lost: auto_retry failed → payment_link timed out → alt_method failed.
    razorpay_payment_id: "pay_esc_lost", amount: 300, currency: "INR", status: "lost", created_at: "2026-08-23T09:00:00Z",
    failure_classifications: [{ failure_reason: "bank_decline", confidence: 0.8, suggested_strategy: "auto_retry", provider_used: "openrouter" }],
    recovery_attempts: [
      { strategy: "auto_retry", status: "failed", recovered_amount: null, notes: "retry failed" },
      { strategy: "payment_link", status: "failed", recovered_amount: null, notes: "timed out" },
      { strategy: "alt_method", status: "failed", recovered_amount: null, notes: "no path left" },
    ],
  },
]);

// Funnel: 2 payments, both attempted (counted ONCE each despite multiple attempts), 1 recovered.
assert.strictEqual(escalated.funnel.failed, 2, "escalation: 2 payments");
assert.strictEqual(escalated.funnel.recovery_attempted, 2, "escalation: per-payment dedupe (not 5 attempts)");
assert.strictEqual(escalated.funnel.recovered, 1, "escalation: one payment recovered");
// Money: only the recovered payment's amount counts in; the lost chain's full amount is lost.
assert.strictEqual(escalated.money.recovered, 500, "escalation: recovered rupees (once, not per-attempt)");
assert.strictEqual(escalated.money.lost, 300, "escalation: lost chain's amount");
// Strategy table: PER-ATTEMPT (raw) — auto_retry tried twice (both failed), payment_link twice (1 ok),
// alt_method once (failed). This is the escalation visibility the demo narrates from.
const es = (name) => escalated.by_strategy.find((s) => s.strategy === name);
assert.deepStrictEqual(es("auto_retry"), { strategy: "auto_retry", attempted: 2, succeeded: 0, success_rate: 0 }, "auto_retry: 2 attempted, 0 ok");
assert.deepStrictEqual(es("payment_link"), { strategy: "payment_link", attempted: 2, succeeded: 1, success_rate: 0.5 }, "payment_link: 2 attempted, 1 ok");
assert.deepStrictEqual(es("alt_method"), { strategy: "alt_method", attempted: 1, succeeded: 0, success_rate: 0 }, "alt_method: 1 attempted, 0 ok");

console.log("dashboard.test.js: all assertions passed");
