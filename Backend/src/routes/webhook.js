const { Router } = require("express");
const { supabase } = require("../config/supabase");
const { verifyRazorpaySignature } = require("../lib/signature");
const { classifyFailure } = require("../agents/classificationService");
const { verifyClassification } = require("../agents/verifierService");
const { adviseStrategy } = require("../agents/strategyAdvisorService");
const { runOrchestration } = require("../services/orchestratorService");

const router = Router();

// Map a classifyFailure() result to a failure_classifications row.
// NB: the table column is `failure_reason` but the service returns `reason` — keep this rename
// in one place so it can't silently drift. Guarded by webhook.test.js.
function buildClassificationRow(paymentId, result, advisorNote = null) {
  return {
    payment_id: paymentId,
    failure_reason: result.reason,
    detail: result.detail,
    confidence: result.confidence,
    suggested_strategy: result.suggested_strategy,
    provider_used: result.provider_used,
    verified: result.verified === true, // true only when the verifier overrode the primary (see verifierService)
    advisor_note: advisorNote, // one-line justification for the strategy actually used (strategyAdvisorService)
    raw_llm_response: result,
  };
}

// Classify a stored failed payment and persist it. Fire-and-forget: called AFTER we've already
// 200'd Razorpay, so LLM latency never risks the webhook timeout. Never rejects — classification
// failure must never take down the webhook path.
// ponytail: no retry queue — if the process dies mid-classify this payment stays unclassified;
// add a reconciliation sweep (payments with no failure_classifications) if that bites in Phase 4.
async function classifyAndStore(paymentId, payment) {
  try {
    const primary = await classifyFailure({
      error_code: payment.error_code,
      error_description: payment.error_description,
    });
    // Second opinion: only spends an API call when primary confidence is low, and may override the
    // reason/strategy. Never throws (falls back to primary). Runs before store + orchestration so the
    // FINAL decision is what gets persisted and acted on.
    const result = await verifyClassification(payment, primary);

    // Strategy advisor: reweight the suggested strategy against historical recovery outcomes for this
    // reason. Never throws (falls back to the suggested strategy). Its output IS the strategy we act on
    // and store on recovery_attempts; the justification goes on the classification row as advisor_note.
    const advice = await adviseStrategy(result.reason, result.suggested_strategy);

    const { error } = await supabase
      .from("failure_classifications")
      .insert(buildClassificationRow(paymentId, result, advice.note));
    if (error) console.error("[classify] store failed:", error.message);

    // Phase 3+5: act on the decision via the orchestrator — it creates the first recovery_attempts
    // row (identical to the old direct executeRecovery call) and, if that strategy's async outcome
    // fails/times out, escalates through the fixed policy (auto_retry → payment_link → alt_method →
    // lost). Runs off the in-memory result so a classification-store hiccup doesn't skip recovery.
    // Never throws and is fire-and-forget (webhook already 200'd above).
    await runOrchestration(paymentId, payment, advice.strategy);
  } catch (err) {
    // classifyFailure is documented never to throw; guard anyway so a stray error can't crash the process.
    console.error("[classify] unexpected error:", err.message);
  }
}

// Pure (no I/O): pull what we need out of a payment_link.paid payload. Returns null if it isn't one
// of OUR recovery links. reference_id is `rec_<razorpay_payment_id>` (set in recoveryService — note
// it encodes the razorpay payment id, NOT the recovery_attempt id). Razorpay sends BOTH entities on
// this event: reference_id lives on payment_link.entity, the paid amount on payment.entity (paise).
// Exported + guarded by webhook.test.js.
function parsePaymentLinkPaid(body) {
  const payload = body.payload || {};
  const link = payload.payment_link && payload.payment_link.entity;
  const pay = payload.payment && payload.payment.entity;
  const referenceId = link && link.reference_id;
  if (!referenceId || !referenceId.startsWith("rec_")) return null;
  const paise = (pay && pay.amount) || (link && link.amount) || 0;
  return {
    razorpayPaymentId: referenceId.slice("rec_".length),
    recovered_amount: paise / 100, // store rupees — matches payments.amount + auto_retry success
  };
}

// Pure (no I/O): pull the failed-payment entity out of a payment.failed payload, or null if it's
// malformed (missing/null nested fields, or no id). A signed-but-garbage payload must never reach
// the raw nested access — that crashed the process in Phase 4 testing. Exported + guarded by webhook.test.js.
function parseFailedPayment(body) {
  const payload = (body && body.payload) || {};
  const entity = payload.payment && payload.payment.entity;
  if (!entity || !entity.id) return null;
  return entity;
}

// payment_link.paid → flip the matching payment_link recovery_attempts row to success.
// Match path: reference_id → payments.razorpay_payment_id → payments.id → recovery_attempts row.
async function handlePaymentLinkPaid(req, res) {
  const parsed = parsePaymentLinkPaid(req.body);
  if (!parsed) {
    console.warn("[webhook] payment_link.paid ignored — reference_id is not a rec_ recovery link");
    return res.status(200).json({ ignored: true });
  }

  const { data: pay, error: payErr } = await supabase
    .from("payments")
    .select("id")
    .eq("razorpay_payment_id", parsed.razorpayPaymentId)
    .single();
  if (payErr || !pay) {
    console.error(`[webhook] payment_link.paid: no payments row for ${parsed.razorpayPaymentId}: ${payErr && payErr.message}`);
    return res.status(200).json({ unmatched: true });
  }

  // Atomically CLAIM the payment_link row: flip pending→success ONLY if it's still pending. This is
  // the mirror of the orchestrator's timeout claim (orchestratorService.escalateOnLinkTimeout, which
  // flips pending→failed). Whichever fires SECOND matches 0 rows and no-ops — so a late payment can't
  // overwrite a row the timeout already escalated, and the timeout can't overwrite a paid row. Also
  // makes duplicate paid deliveries idempotent (second one sees status=success → 0 rows).
  const { data: updated, error: updErr } = await supabase
    .from("recovery_attempts")
    .update({ status: "success", recovered_amount: parsed.recovered_amount, notes: "Payment link paid — payment recovered" })
    .eq("payment_id", pay.id)
    .eq("strategy", "payment_link")
    .eq("status", "pending")
    .select("id");
  if (updErr) {
    console.error(`[webhook] payment_link.paid update failed for payment ${pay.id}: ${updErr.message}`);
    return res.status(500).json({ error: "update failed" }); // 500 → let Razorpay retry
  }
  const count = updated ? updated.length : 0;
  if (count === 0) {
    console.log(`[webhook] payment_link.paid → payment ${pay.id} link already resolved (escalated or duplicate) — no-op`);
  } else {
    console.log(`[webhook] payment_link.paid → marked ${count} recovery_attempts row(s) success for payment ${pay.id}`);
  }
  return res.status(200).json({ updated: count });
}

// POST /api/webhook/razorpay — verify signature, store the failed payment, then classify (Phase 2).
router.post("/webhook/razorpay", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  // Two-account failover (see recoveryService.js): both accounts post to this same endpoint but each
  // signs with its own webhook secret — accept a match against either. _2 is optional (single-account
  // setups just have the one). Use the SAME secret string on both accounts and _2 is simply redundant.
  const secrets = [process.env.RAZORPAY_WEBHOOK_SECRET, process.env.RAZORPAY_WEBHOOK_SECRET_2].filter(Boolean);

  if (!verifyRazorpaySignature(req.rawBody, signature, secrets)) {
    return res.status(400).json({ error: "invalid signature" });
  }

  if (req.body.event === "payment_link.paid") {
    return handlePaymentLinkPaid(req, res);
  }

  if (req.body.event !== "payment.failed") {
    return res.status(200).json({ ignored: true });
  }

  const payment = parseFailedPayment(req.body);
  if (!payment) {
    console.warn("[webhook] payment.failed with missing/malformed payment entity — rejecting");
    return res.status(400).json({ error: "malformed payload" });
  }

  const { data: inserted, error } = await supabase
    .from("payments")
    .insert({
      razorpay_payment_id: payment.id,
      razorpay_order_id: payment.order_id,
      amount: payment.amount / 100, // Razorpay sends paise; store rupees
      currency: payment.currency,
      method: payment.method, // card | upi | netbanking | wallet | emi | ...  (undefined on some edge events → stored null)
      error_code: payment.error_code,
      error_description: payment.error_description,
      status: "failed",
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation: Razorpay re-delivered an event we already stored. Ack 200 so it
    // stops retrying — and do NOT re-classify (classification runs on first insert only).
    // Under a concurrent storm the duplicate can surface without error.code populated (seen in Phase 4
    // testing: one of 8 racing dupes returned 500), so match the message as a fallback — any duplicate
    // must 200, never 500.
    const isDuplicate =
      error.code === "23505" || /duplicate key|unique constraint/i.test(error.message || "");
    if (isDuplicate) {
      return res.status(200).json({ duplicate: true });
    }
    console.error("DB insert failed:", error.message);
    return res.status(500).json({ error: "db insert failed" });
  }

  // Ack Razorpay first, then classify out of band so the LLM call can't delay the webhook response.
  res.status(200).json({ received: true });
  classifyAndStore(inserted.id, payment);
});

module.exports = router;
router.buildClassificationRow = buildClassificationRow; // exposed for webhook.test.js
router.parsePaymentLinkPaid = parsePaymentLinkPaid; // exposed for webhook.test.js
router.parseFailedPayment = parseFailedPayment; // exposed for webhook.test.js
router.classifyAndStore = classifyAndStore; // reused by the reconciliation sweep (test.js)
