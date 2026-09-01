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

// Money: pay_1 recovered (500), pay_2 pending (300), Lost (pay_3 + pay_4) = 200 + 100 = 300.
assert.strictEqual(r.money.recovered, 500, "recovered rupees");
assert.strictEqual(r.money.pending, 300, "pending rupees (in progress attempt)");
assert.strictEqual(r.money.lost, 300, "lost rupees (unrecovered without pending attempt)");
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

// Isolated test: payment with exactly one attempt whose status is "pending" (no success, no failed)
const pendingOnly = aggregate([
  {
    razorpay_payment_id: "pay_pending_only", amount: 750, currency: "INR", status: "failed", created_at: "2026-08-22T10:00:00Z",
    failure_classifications: [{ failure_reason: "insufficient_funds", confidence: 0.95, suggested_strategy: "payment_link" }],
    recovery_attempts: [{ strategy: "payment_link", status: "pending", recovered_amount: null, notes: "link sent" }],
  },
]);
assert.strictEqual(pendingOnly.money.pending, 750, "pending payment contributes to money.pending");
assert.strictEqual(pendingOnly.money.lost, 0, "pending payment does NOT contribute to money.lost");
assert.strictEqual(pendingOnly.money.recovered, 0, "pending payment does NOT contribute to money.recovered");

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

// --- Journeys pagination & filtering tests ---
const { filterJourneys, getJourneys } = require("./dashboard");

const journeyRows = [
  {
    razorpay_payment_id: "pay_101_alpha", amount: 1500, currency: "INR", status: "failed", created_at: "2026-08-25T10:00:00Z",
    failure_classifications: [{ failure_reason: "insufficient_funds", confidence: 0.9, suggested_strategy: "auto_retry", provider_used: "groq_key1" }],
    recovery_attempts: [{ strategy: "auto_retry", status: "success", recovered_amount: 1500, notes: "recovered ok" }],
  },
  {
    razorpay_payment_id: "pay_102_beta", amount: 2500, currency: "INR", status: "lost", created_at: "2026-08-25T09:00:00Z",
    failure_classifications: [{ failure_reason: "card_expired", confidence: 0.85, suggested_strategy: "payment_link", provider_used: "mistral" }],
    recovery_attempts: [{ strategy: "payment_link", status: "failed", recovered_amount: null, notes: "link expired" }],
  },
  {
    razorpay_payment_id: "pay_103_gamma", amount: 3500, currency: "INR", status: "failed", created_at: "2026-08-25T08:00:00Z",
    failure_classifications: [{ failure_reason: "bank_decline", confidence: 0.8, suggested_strategy: "alt_method", provider_used: "groq_key1" }],
    recovery_attempts: [{ strategy: "alt_method", status: "pending", recovered_amount: null, notes: "awaiting user" }],
  },
  {
    razorpay_payment_id: "pay_104_delta", amount: 4500, currency: "INR", status: "failed", created_at: "2026-08-25T07:00:00Z",
    failure_classifications: [{ failure_reason: "insufficient_funds", confidence: 0.75, suggested_strategy: "auto_retry", provider_used: "groq_key1" }],
    recovery_attempts: [],
  },
];

(async () => {
  // 1. Default pagination
  {
    const res = filterJourneys(journeyRows, {});
    assert.strictEqual(res.total, 4, "default pagination returns total=4");
    assert.strictEqual(res.limit, 20, "default limit is 20");
    assert.strictEqual(res.offset, 0, "default offset is 0");
    assert.strictEqual(res.items.length, 4, "returns all 4 items");
  }

  // 2. Limit and offset pagination
  {
    const res = filterJourneys(journeyRows, { limit: 2, offset: 1 });
    assert.strictEqual(res.total, 4, "total is 4 with limit and offset");
    assert.strictEqual(res.limit, 2, "limit is 2");
    assert.strictEqual(res.offset, 1, "offset is 1");
    assert.strictEqual(res.items.length, 2, "items length is 2");
    assert.strictEqual(res.items[0].razorpay_payment_id, "pay_102_beta", "first item matches offset 1");
  }

  // 3. Out-of-range / invalid limit clamping
  {
    const over = filterJourneys(journeyRows, { limit: 500 });
    assert.strictEqual(over.limit, 100, "limit=500 clamped to 100");

    const invalid = filterJourneys(journeyRows, { limit: "invalid" });
    assert.strictEqual(invalid.limit, 20, "invalid limit defaults to 20");

    const negative = filterJourneys(journeyRows, { limit: -5 });
    assert.strictEqual(negative.limit, 20, "negative limit defaults to 20");
  }

  // 4. Status filter ('recovered' | 'lost' | 'pending' | 'none')
  {
    const rec = filterJourneys(journeyRows, { status: "recovered" });
    assert.strictEqual(rec.total, 1, "status=recovered narrows to 1 item");
    assert.strictEqual(rec.items[0].razorpay_payment_id, "pay_101_alpha");

    const lost = filterJourneys(journeyRows, { status: "lost" });
    assert.strictEqual(lost.total, 1, "status=lost narrows to 1 item");
    assert.strictEqual(lost.items[0].razorpay_payment_id, "pay_102_beta");

    const pend = filterJourneys(journeyRows, { status: "pending" });
    assert.strictEqual(pend.total, 1, "status=pending narrows to 1 item");
    assert.strictEqual(pend.items[0].razorpay_payment_id, "pay_103_gamma");

    const none = filterJourneys(journeyRows, { status: "none" });
    assert.strictEqual(none.total, 1, "status=none narrows to 1 item");
    assert.strictEqual(none.items[0].razorpay_payment_id, "pay_104_delta");
  }

  // 5. Reason filter
  {
    const res = filterJourneys(journeyRows, { reason: "insufficient_funds" });
    assert.strictEqual(res.total, 2, "reason=insufficient_funds matches 2 items");
  }

  // 6. Strategy filter
  {
    const res = filterJourneys(journeyRows, { strategy: "payment_link" });
    assert.strictEqual(res.total, 1, "strategy=payment_link matches 1 item");
    assert.strictEqual(res.items[0].razorpay_payment_id, "pay_102_beta");
  }

  // 7. Search filter (partial ID and exact amount)
  {
    const partial = filterJourneys(journeyRows, { search: "alpha" });
    assert.strictEqual(partial.total, 1, "partial search 'alpha' matches 1 item");
    assert.strictEqual(partial.items[0].razorpay_payment_id, "pay_101_alpha");

    const amountSearch = filterJourneys(journeyRows, { search: "3500" });
    assert.strictEqual(amountSearch.total, 1, "search '3500' matches exact amount");
    assert.strictEqual(amountSearch.items[0].razorpay_payment_id, "pay_103_gamma");
  }

  // 8. getJourneys test dependency seam
  {
    const res = await getJourneys({ search: "gamma" }, { loadRows: async () => journeyRows });
    assert.strictEqual(res.total, 1, "getJourneys uses dependency seam");
    assert.strictEqual(res.items[0].razorpay_payment_id, "pay_103_gamma");
  }

  console.log("dashboard.test.js: all assertions passed");
})();

