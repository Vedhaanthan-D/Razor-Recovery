const { supabase } = require("../config/supabase");
const { executeRecovery } = require("./recoveryService");
const { ESCALATION_POLICY } = require("../config/escalationPolicy");

// Deterministic escalation state machine. NOT an AI agent — no LLM call happens here. The reasoning
// happened once, upstream, in classificationService.js; this layer just sequences that decision via
// ESCALATION_POLICY so a failed first strategy escalates instead of dead-ending. See CLAUDE.md /
// phase-5.md for the terminology note (don't overstate this as "agentic").

// Pure (no I/O): given a strategy and what happened to it ('fail' | 'timeout'), what runs next?
// Returns { next, terminal }. next=null + terminal=true means "chain exhausted — mark the payment lost".
// Exported for orchestratorService.test.js — this is the whole decision, so it's the part worth a check.
function nextStrategy(strategy, trigger) {
  const policy = ESCALATION_POLICY[strategy] || {};
  const next = trigger === "timeout" ? policy.onTimeout : policy.onFail;
  // A strategy that IS in the policy but routes nowhere on failure (explicit null onFail) is terminal.
  const terminal = next == null && strategy in ESCALATION_POLICY && "onFail" in policy;
  return { next: next || null, terminal };
}

// Pure: the payment_link timeout window in ms (0 if the strategy has none). Exported for the test.
function timeoutMs(strategy) {
  const mins = (ESCALATION_POLICY[strategy] || {}).timeoutMinutes;
  return mins ? mins * 60 * 1000 : 0;
}

// Mark a payment genuinely unrecoverable. Reuses payments.status ('lost' is already in the schema's
// documented set) — least invasive, no new column, no dashboard-query changes. Guarded with a
// != 'recovered' filter so a (hypothetical future) concurrent success can't be clobbered back to lost.
async function markLost(paymentId) {
  const { error } = await supabase
    .from("payments")
    .update({ status: "lost", updated_at: new Date().toISOString() })
    .eq("id", paymentId)
    .neq("status", "recovered");
  if (error) {
    console.error(`[orchestrator] payment ${paymentId}: failed to mark lost: ${error.message}`);
    return;
  }
  console.log(`[orchestrator] payment ${paymentId}: recovery chain exhausted — marked lost`);
}

// Run one strategy attempt and wire everything that should happen when it resolves. Recursive across
// the chain: escalating is just runStrategy() again with the next strategy.
async function runStrategy(paymentId, payment, strategy) {
  // onResolve fires only for the mocked strategies (auto_retry, alt_method). payment_link has no
  // mocked resolution — it resolves via the payment_link.paid webhook (success) or the timeout below.
  const onResolve = (outcome) => {
    if (outcome === "success") return; // recovered — chain ends here
    const { next, terminal } = nextStrategy(strategy, "fail");
    if (next) {
      console.log(`[orchestrator] payment ${paymentId}: ${strategy} failed → escalating to ${next}`);
      runStrategy(paymentId, payment, next).catch((err) =>
        console.error(`[orchestrator] payment ${paymentId}: escalation to ${next} crashed: ${err.message}`)
      );
    } else if (terminal) {
      markLost(paymentId);
    }
  };

  const attemptId = await executeRecovery(paymentId, payment, strategy, onResolve);
  if (!attemptId) return; // insert failed (already logged) — nothing to schedule

  if (strategy === "payment_link") {
    scheduleLinkTimeout(paymentId, payment, attemptId);
  }
}

function scheduleLinkTimeout(paymentId, payment, attemptId) {
  const ms = timeoutMs("payment_link");
  if (!ms) return;
  console.log(`[orchestrator] payment ${paymentId}: payment_link ${attemptId} pending — timeout in ${ms}ms`);
  const timer = setTimeout(() => {
    escalateOnLinkTimeout(paymentId, payment, attemptId).catch((err) =>
      console.error(`[orchestrator] payment ${paymentId}: link timeout handler crashed: ${err.message}`)
    );
  }, ms);
  // ponytail: in-memory timer, lost on restart — same pattern as the mocked auto_retry resolve. A
  // durable job queue is explicitly out of scope (phase-5.md); the reconciliation sweep covers orphans.
  if (timer.unref) timer.unref();
}

// Timeout fired. Atomically CLAIM the payment_link row: flip pending→failed ONLY if it's still pending.
// - We claim it (1 row updated) => the customer never paid in time => escalate to alt_method.
// - We don't (0 rows)           => payment_link.paid already marked it success => no-op, no escalation.
// The mirror guard lives in handlePaymentLinkPaid (webhook.js): it flips pending→success only while
// still pending. So whichever of {timeout, paid-webhook} runs SECOND loses the claim and no-ops —
// the row's first terminal state sticks, no incorrect overwrite in either direction.
async function escalateOnLinkTimeout(paymentId, payment, attemptId) {
  const { data, error } = await supabase
    .from("recovery_attempts")
    .update({ status: "failed", notes: "Payment link not paid within timeout — escalating to alternate method" })
    .eq("id", attemptId)
    .eq("status", "pending")
    .select("id");
  if (error) {
    console.error(`[orchestrator] payment ${paymentId}: link timeout claim failed: ${error.message}`);
    return;
  }
  if (!data || data.length === 0) {
    console.log(`[orchestrator] payment ${paymentId}: payment_link ${attemptId} already resolved before timeout — no escalation`);
    return;
  }
  const { next } = nextStrategy("payment_link", "timeout");
  console.log(`[orchestrator] payment ${paymentId}: payment_link timed out → escalating to ${next}`);
  await runStrategy(paymentId, payment, next);
}

/**
 * Entry point — replaces the direct executeRecovery() call in webhook.js. Runs the initial strategy
 * and sets the escalation chain in motion. Fire-and-forget (webhook already 200'd); never throws.
 * With a non-escalating outcome this is behaviourally identical to the old direct call: one attempt row.
 * @param {string} paymentId  payments.id (uuid)
 * @param {object} payment    Razorpay entity (amount in paise)
 * @param {string} initialStrategy  suggested_strategy from classification
 */
async function runOrchestration(paymentId, payment, initialStrategy) {
  console.log(`[orchestrator] payment ${paymentId}: starting recovery with ${initialStrategy}`);
  try {
    await runStrategy(paymentId, payment, initialStrategy);
  } catch (err) {
    console.error(`[orchestrator] payment ${paymentId}: orchestration failed: ${err.message}`);
  }
}

module.exports = { runOrchestration, nextStrategy, timeoutMs };
