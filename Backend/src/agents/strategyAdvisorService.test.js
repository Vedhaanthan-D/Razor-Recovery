// Run: node src/agents/strategyAdvisorService.test.js   (or: npm run test:advisor)
// Pure/deterministic — no DB. Historical recovery_attempts are injected via deps.fetchAttempts as a
// flat [{strategy,status}] list (synthetic history), which exercises the real aggregate + decide path.
const assert = require("assert");
const { adviseStrategy } = require("./strategyAdvisorService");

// Build N attempts of a strategy with `successes` of them succeeding.
function attempts(strategy, total, successes) {
  return Array.from({ length: total }, (_, i) => ({ strategy, status: i < successes ? "success" : "failed" }));
}
const from = (rows) => ({ fetchAttempts: async () => rows });

(async () => {
  // 1. Insufficient data (< 5 total attempts for the reason) → default kept, no override.
  {
    const rows = [...attempts("auto_retry", 2, 1), ...attempts("payment_link", 2, 2)]; // N=4
    const out = await adviseStrategy("network_timeout", "auto_retry", from(rows));
    assert.strictEqual(out.strategy, "auto_retry", "N<5 keeps the default");
    assert.match(out.note, /only 4 historical/, "note explains the small sample");
  }

  // 2. Enough data but nothing beats the default by >= 20pts → default kept.
  {
    // auto_retry 60% vs payment_link 75% → edge is only 15pts (< 20) → keep default.
    const rows = [...attempts("auto_retry", 10, 6), ...attempts("payment_link", 8, 6)]; // N=18
    const out = await adviseStrategy("network_timeout", "auto_retry", from(rows));
    assert.strictEqual(out.strategy, "auto_retry", "no 20pt edge → default kept");
    assert.match(out.note, /confirmed/, "note says confirmed");
  }

  // 3. A strategy clearly outperforms the default by >= 20pts → override to it.
  {
    // auto_retry 37.5% (3/8) vs payment_link 75% (9/12) → 37.5pt edge → override. (matches the task's example)
    const rows = [...attempts("auto_retry", 8, 3), ...attempts("payment_link", 12, 9)]; // N=20
    const out = await adviseStrategy("network_timeout", "auto_retry", from(rows));
    assert.strictEqual(out.strategy, "payment_link", "clear winner overrides the default");
    assert.strictEqual(out.note, "payment_link outperforms auto_retry 75% vs 37.5% for network_timeout, based on 20 past attempts.", "note is the demo justification");
  }

  // 3b. When multiple rivals beat the default, the highest-rate one wins.
  {
    const rows = [
      ...attempts("auto_retry", 10, 2), // 20% default
      ...attempts("payment_link", 10, 7), // 70%
      ...attempts("alt_method", 10, 9), // 90% ← best
    ]; // N=30
    const out = await adviseStrategy("bank_decline", "auto_retry", from(rows));
    assert.strictEqual(out.strategy, "alt_method", "best-performing rival is chosen");
  }

  // 4. The dead-card auto_retry ban holds even when auto_retry has the best history.
  {
    // auto_retry 100% (10/10) would win, but card_expired must NEVER route to auto_retry → keep default.
    const rows = [...attempts("auto_retry", 10, 10), ...attempts("payment_link", 10, 3)]; // N=20
    const out = await adviseStrategy("card_expired", "payment_link", from(rows));
    assert.strictEqual(out.strategy, "payment_link", "card_expired never overrides into auto_retry");
    const out2 = await adviseStrategy("card_invalid", "payment_link", from(rows));
    assert.strictEqual(out2.strategy, "payment_link", "card_invalid never overrides into auto_retry");
  }

  // 5. DB/lookup failure → safe fallback to the default, no throw.
  {
    const out = await adviseStrategy("network_timeout", "auto_retry", {
      fetchAttempts: async () => { throw new Error("connection reset"); },
    });
    assert.strictEqual(out.strategy, "auto_retry", "lookup failure keeps the default");
    assert.match(out.note, /unavailable/, "note flags the missing history");
  }

  console.log("strategyAdvisorService.test.js: all assertions passed");
})().catch((e) => {
  console.error("self-test crashed (adviseStrategy should never throw):", e);
  process.exit(1);
});
