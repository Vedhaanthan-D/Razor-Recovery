const { Router } = require("express");
const { supabase } = require("../config/supabase");

const router = Router();

// One query, embed classification (0-or-1) and recovery attempts (0-or-many) per payment.
const SELECT =
  "razorpay_payment_id,amount,currency,method,error_code,error_description,status,created_at," +
  "failure_classifications(failure_reason,detail,confidence,suggested_strategy,provider_used,verified,advisor_note)," +
  "recovery_attempts(strategy,status,recovered_amount,notes,attempted_at)";

const RECENT_LIMIT = 50;

// Pure (no I/O): roll payment rows up into the dashboard's funnel, money, and breakdowns.
// Exported for dashboard.test.js — this is where the money/funnel math lives, so it's the part
// worth a unit check. `rows` is the Supabase select above (newest-first).
function aggregate(rows) {
  const funnel = { failed: 0, classified: 0, recovery_attempted: 0, recovered: 0 };
  const money = { recovered: 0, lost: 0, currency: "INR" };
  const reasonCounts = {};
  const strategyStats = {}; // strategy -> { attempted, succeeded }
  const recent = [];

  for (const p of rows) {
    funnel.failed++;
    const cls = (p.failure_classifications && p.failure_classifications[0]) || null;
    const attempts = p.recovery_attempts || [];
    const succeeded = attempts.find((a) => a.status === "success") || null;

    if (cls) {
      funnel.classified++;
      if (cls.failure_reason) reasonCounts[cls.failure_reason] = (reasonCounts[cls.failure_reason] || 0) + 1;
    }
    if (attempts.length) funnel.recovery_attempted++;
    if (succeeded) funnel.recovered++;

    // A payment is "recovered" (money in) if any attempt succeeded; otherwise its full amount is lost.
    if (succeeded) money.recovered += Number(succeeded.recovered_amount) || 0;
    else money.lost += Number(p.amount) || 0;
    if (p.currency) money.currency = p.currency;

    for (const a of attempts) {
      const s = (strategyStats[a.strategy] ||= { attempted: 0, succeeded: 0 });
      s.attempted++;
      if (a.status === "success") s.succeeded++;
    }

    recent.push({
      razorpay_payment_id: p.razorpay_payment_id,
      amount: p.amount,
      currency: p.currency,
      method: p.method, // card | upi | netbanking | ... — null on rows created before the method migration
      error_code: p.error_code,
      error_description: p.error_description,
      status: p.status,
      created_at: p.created_at,
      failure_reason: cls ? cls.failure_reason : null,
      detail: cls ? cls.detail : null,
      confidence: cls ? cls.confidence : null,
      suggested_strategy: cls ? cls.suggested_strategy : null,
      provider_used: cls ? cls.provider_used : null,
      verified: cls ? !!cls.verified : null, // true = verifier overrode the primary classification
      advisor_note: cls ? cls.advisor_note : null, // why this strategy — hover detail next to Strategy (like `detail` for reason)
      recovery_strategy: attempts[0] ? attempts[0].strategy : null,
      recovery_status: succeeded ? "success" : attempts[0] ? attempts[0].status : null,
      recovered_amount: succeeded ? succeeded.recovered_amount : null,
      recovery_notes: attempts[0] ? attempts[0].notes : null,
      // Full ordered attempt list for the /agents escalation trace (recovery_strategy above is only
      // the first). Sorted by attempted_at so the chain reads auto_retry → payment_link → alt_method.
      attempts: attempts
        .slice()
        .sort((a, b) => String(a.attempted_at || "").localeCompare(String(b.attempted_at || "")))
        .map((a) => ({
          strategy: a.strategy,
          status: a.status,
          recovered_amount: a.recovered_amount,
          notes: a.notes,
          attempted_at: a.attempted_at,
        })),
    });
  }

  const by_reason = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const by_strategy = Object.entries(strategyStats)
    .map(([strategy, s]) => ({
      strategy,
      attempted: s.attempted,
      succeeded: s.succeeded,
      success_rate: s.attempted ? s.succeeded / s.attempted : 0,
    }))
    .sort((a, b) => b.attempted - a.attempted);

  return { funnel, money, by_reason, by_strategy, recent };
}

// Query + aggregate the whole payment history. Exported so the insights agent reuses the SAME
// query and rollup instead of requerying separately. Throws on DB error (callers handle it).
async function loadAggregate() {
  const { data, error } = await supabase
    .from("payments")
    .select(SELECT)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return aggregate(data || []);
}

// GET /api/dashboard — funnel + money + breakdowns + recent activity for the product dashboard.
// Uses the service_role client (same proven pattern as /api/debug/payments), so the browser needs
// no anon RLS policy. Aggregation is server-side (dataset is small) to keep the frontend dumb.
router.get("/dashboard", async (_req, res) => {
  try {
    const out = await loadAggregate();
    out.recent = out.recent.slice(0, RECENT_LIMIT); // funnel/money use all history; table shows latest N
    res.json(out);
  } catch (err) {
    console.error("[dashboard] query failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
router.aggregate = aggregate; // exposed for dashboard.test.js
router.loadAggregate = loadAggregate; // reused by insightsService
