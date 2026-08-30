const { supabase } = require("../config/supabase");
const { banCardAutoRetry } = require("./classificationService"); // reuse the dead-card retry ban — do NOT reimplement

// Strategy Advisor: reweights the classifier's suggested_strategy using REAL historical recovery
// outcomes for the same failure reason. Deliberately simple + explainable (one-line justification for
// the demo, not a black box). Runs after classification+verification, before orchestration.
//
// Reality check (say this in the demo, honestly): with low live volume this returns "insufficient
// data" and keeps the default. Its value is proven by the unit tests on synthetic history.
const MIN_SAMPLE = 5; // total historical attempts for a reason below which we don't trust the data
const MIN_EDGE = 0.2; // a rival strategy must beat the default by >= 20 percentage points to override

// 37.5%, 75% — trim the trailing ".0" but keep one decimal when it matters.
const pct = (r) => +(r * 100).toFixed(1);

// I/O: flat list of {strategy, status} for every recovery attempt on payments classified as `reason`.
// Reuses the payments→failure_classifications / payments→recovery_attempts embeds the dashboard
// already relies on (both children FK payments.id). !inner keeps only payments with a matching reason.
async function fetchAttempts(reason) {
  const { data, error } = await supabase
    .from("payments")
    .select("recovery_attempts(strategy,status), failure_classifications!inner(failure_reason)")
    .eq("failure_classifications.failure_reason", reason);
  if (error) throw new Error(error.message);
  const rows = [];
  for (const p of data || []) for (const a of p.recovery_attempts || []) rows.push({ strategy: a.strategy, status: a.status });
  return rows;
}

// Pure: {strategy, status}[] -> { strategy: {attempts, successes, rate} }.
function aggregate(rows) {
  const stats = {};
  for (const a of rows) {
    const s = (stats[a.strategy] ||= { attempts: 0, successes: 0, rate: 0 });
    s.attempts++;
    if (a.status === "success") s.successes++;
  }
  for (const s of Object.values(stats)) s.rate = s.attempts ? s.successes / s.attempts : 0;
  return stats;
}

// Pure: the whole decision + its one-line justification. Returns { strategy, note }.
function decide(reason, defaultStrategyRaw, stats) {
  // Correct the incoming default through the invariant up front so logs/notes/comparison all agree
  // (normal callers already pass a legal default — this is defense-in-depth, and a no-op for them).
  const defaultStrategy = banCardAutoRetry(reason, defaultStrategyRaw);
  const N = Object.values(stats).reduce((t, s) => t + s.attempts, 0);
  const def = stats[defaultStrategy] || { attempts: 0, successes: 0, rate: 0 };

  if (N < MIN_SAMPLE) {
    console.log(`[advisor] insufficient data (${N}<${MIN_SAMPLE}), using default.`);
    return { strategy: defaultStrategy, note: `${defaultStrategy} kept for ${reason}: only ${N} historical attempt(s), need ${MIN_SAMPLE}.` };
  }

  // Best DIFFERENT strategy that (a) the dead-card retry ban permits and (b) beats the default by
  // >= MIN_EDGE. banCardAutoRetry(reason, s) !== s means the ban would rewrite s -> so s is illegal here.
  const better = Object.entries(stats)
    .filter(([s]) => s !== defaultStrategy)
    .filter(([s]) => banCardAutoRetry(reason, s) === s)
    .filter(([, v]) => v.rate >= def.rate + MIN_EDGE)
    .sort((a, b) => b[1].rate - a[1].rate)[0];

  if (better) {
    const [strategy, v] = better;
    console.log(`[advisor] overrode ${defaultStrategy} (rate ${pct(def.rate)}%) -> ${strategy} (rate ${pct(v.rate)}%), N=${N}`);
    return { strategy, note: `${strategy} outperforms ${defaultStrategy} ${pct(v.rate)}% vs ${pct(def.rate)}% for ${reason}, based on ${N} past attempts.` };
  }

  console.log(`[advisor] default ${defaultStrategy} confirmed, rate ${pct(def.rate)}%`);
  return { strategy: defaultStrategy, note: `${defaultStrategy} confirmed for ${reason}: ${pct(def.rate)}% success over ${N} past attempts, and no alternative strategy performs meaningfully better.` };
}

/**
 * Reweight a strategy against historical recovery outcomes for its failure reason. Never throws.
 * @param {string} reason           post-verification failure_reason
 * @param {string} defaultStrategy  the classification/verifier suggested_strategy
 * @param {{ fetchAttempts?: (reason) => Promise<{strategy,status}[]> }} [deps] test seam
 * @returns {Promise<{ strategy: string, note: string }>} strategy to use + one-line justification (advisor_note)
 */
async function adviseStrategy(reason, defaultStrategy, deps = {}) {
  const fetch = deps.fetchAttempts || fetchAttempts;
  let rows;
  try {
    rows = await fetch(reason);
  } catch (err) {
    console.error(`[advisor] lookup failed, using default (${err.message})`);
    return { strategy: defaultStrategy, note: `Strategy history unavailable; used default ${defaultStrategy}.` };
  }
  return decide(reason, defaultStrategy, aggregate(rows));
}

module.exports = { adviseStrategy, aggregate, decide };
