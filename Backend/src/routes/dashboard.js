const { Router } = require("express");
const { supabase } = require("../config/supabase");

const router = Router();

// One query, embed classification (0-or-1) and recovery attempts (0-or-many) per payment.
const SELECT =
  "razorpay_payment_id,amount,currency,method,error_code,error_description,status,created_at," +
  "failure_classifications(failure_reason,detail,confidence,suggested_strategy,provider_used,verified,advisor_note)," +
  "recovery_attempts(strategy,status,recovered_amount,notes,attempted_at)";

const RECENT_LIMIT = 50;

/**
 * Format a raw payment database row (with embedded classifications and attempts) into a trace object.
 * @param {object} p
 * @returns {object}
 */
function formatTraceItem(p) {
  const cls = (p.failure_classifications && p.failure_classifications[0]) || null;
  const attempts = p.recovery_attempts || [];
  const succeeded = attempts.find((a) => a.status === "success") || null;

  return {
    razorpay_payment_id: p.razorpay_payment_id,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    error_code: p.error_code,
    error_description: p.error_description,
    status: p.status,
    created_at: p.created_at,
    failure_reason: cls ? cls.failure_reason : null,
    detail: cls ? cls.detail : null,
    confidence: cls ? cls.confidence : null,
    suggested_strategy: cls ? cls.suggested_strategy : null,
    provider_used: cls ? cls.provider_used : null,
    verified: cls ? !!cls.verified : null,
    advisor_note: cls ? cls.advisor_note : null,
    recovery_strategy: attempts[0] ? attempts[0].strategy : null,
    recovery_status: succeeded ? "success" : attempts[0] ? attempts[0].status : null,
    recovered_amount: succeeded ? succeeded.recovered_amount : null,
    recovery_notes: attempts[0] ? attempts[0].notes : null,
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
  };
}

/**
 * Compute terminal outcome status for filtering ('recovered' | 'lost' | 'pending' | 'none').
 * @param {object} p
 * @param {object} trace
 * @returns {'recovered' | 'lost' | 'pending' | 'none'}
 */
function getOutcomeStatus(p, trace) {
  if (trace.recovery_status === "success" || p.status === "recovered") return "recovered";
  if (p.status === "lost") return "lost";
  if (!trace.attempts || trace.attempts.length === 0) return "none";
  if (trace.attempts.some((a) => a.status === "pending")) return "pending";
  if (trace.attempts.every((a) => a.status === "failed")) return "lost";
  return "none";
}

// Pure (no I/O): roll payment rows up into the dashboard's funnel, money, and breakdowns.
// Exported for dashboard.test.js — this is where the money/funnel math lives, so it's the part
// worth a unit check. `rows` is the Supabase select above (newest-first).
function aggregate(rows) {
  const funnel = { failed: 0, classified: 0, recovery_attempted: 0, recovered: 0 };
  const money = { recovered: 0, lost: 0, pending: 0, currency: "INR" };
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

    // A payment is "recovered" (money in) if any attempt succeeded; if in progress, pending; otherwise lost.
    if (succeeded) {
      money.recovered += Number(succeeded.recovered_amount) || 0;
    } else if (attempts.some((a) => a.status === "pending")) {
      money.pending = (money.pending || 0) + (Number(p.amount) || 0);
    } else {
      money.lost += Number(p.amount) || 0;
    }
    if (p.currency) money.currency = p.currency;

    for (const a of attempts) {
      const s = (strategyStats[a.strategy] ||= { attempted: 0, succeeded: 0 });
      s.attempted++;
      if (a.status === "success") s.succeeded++;
    }

    recent.push(formatTraceItem(p));
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

  const template_summary = templateSummary({ funnel, money, by_reason });

  return { funnel, money, by_reason, by_strategy, recent, template_summary };
}

function fmtMoney(n, currency) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency || "INR"} ${Math.round(n)}`;
  }
}

function templateSummary({ funnel, money, by_reason }) {
  const total = money.recovered + money.lost + (money.pending || 0);
  const rate = funnel.failed ? Math.round((funnel.recovered / funnel.failed) * 100) : 0;
  const topReason = by_reason[0] ? by_reason[0].reason.replace(/_/g, " ") : "none";
  return `Recovered ${fmtMoney(money.recovered, money.currency)} of ${fmtMoney(total, money.currency)} (${rate}% recovery rate). ${fmtMoney(money.pending || 0, money.currency)} still in progress. Top failure: ${topReason}.`;
}



/**
 * Filter and paginate payment journey traces based on query parameters.
 * @param {Array<object>} rows
 * @param {object} query
 * @returns {{ items: Array<object>, total: number, limit: number, offset: number }}
 */
function filterJourneys(rows, query = {}) {
  let limit = parseInt(query.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  let offset = parseInt(query.offset, 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  let statusFilter = query.status ? String(query.status).trim().toLowerCase() : null;
  if (statusFilter === "awaiting") statusFilter = "none";
  const reasonFilter = query.reason ? String(query.reason).trim() : null;
  const strategyFilter = query.strategy ? String(query.strategy).trim() : null;
  const searchFilter = query.search ? String(query.search).trim() : null;

  const filtered = [];
  for (const p of rows) {
    const trace = formatTraceItem(p);
    const outcome = getOutcomeStatus(p, trace);

    if (statusFilter && outcome !== statusFilter) continue;
    if (reasonFilter && trace.failure_reason !== reasonFilter) continue;
    if (
      strategyFilter &&
      trace.recovery_strategy !== strategyFilter &&
      trace.suggested_strategy !== strategyFilter &&
      !trace.attempts.some((a) => a.strategy === strategyFilter)
    ) {
      continue;
    }
    if (searchFilter) {
      const searchLower = searchFilter.toLowerCase();
      const matchId = trace.razorpay_payment_id && trace.razorpay_payment_id.toLowerCase().includes(searchLower);
      const matchAmount = !isNaN(Number(searchFilter)) && Number(trace.amount) === Number(searchFilter);
      if (!matchId && !matchAmount) continue;
    }

    filtered.push(trace);
  }

  const items = filtered.slice(offset, offset + limit);
  return { items, total: filtered.length, limit, offset };
}

/**
 * Fetch raw payment database rows with embedded joins.
 * @returns {Promise<Array<object>>}
 */
async function loadRawRows() {
  const { data, error } = await supabase
    .from("payments")
    .select(SELECT)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Fetch DB aggregate and return paginated, filtered journey records.
 * @param {object} query
 * @param {{ loadRows?: () => Promise<Array<object>> }} [deps]
 * @returns {Promise<{ items: Array<object>, total: number, limit: number, offset: number }>}
 */
async function getJourneys(query = {}, deps = {}) {
  const load = deps.loadRows || loadRawRows;
  const rows = await load();
  return filterJourneys(rows, query);
}

// Query + aggregate the whole payment history. Exported so the insights agent reuses the SAME
// query and rollup instead of requerying separately. Throws on DB error (callers handle it).
async function loadAggregate() {
  const rows = await loadRawRows();
  return aggregate(rows);
}

// GET /api/dashboard/journeys — paginated & filtered payment journey traces for the Journeys page.
router.get("/dashboard/journeys", async (req, res) => {
  try {
    const out = await getJourneys(req.query);
    res.json(out);
  } catch (err) {
    console.error("[dashboard] journeys query failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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
router.loadRawRows = loadRawRows;
router.formatTraceItem = formatTraceItem;
router.filterJourneys = filterJourneys;
router.getJourneys = getJourneys;

