require("dotenv").config();
const Razorpay = require("razorpay");
const { supabase } = require("../config/supabase");
const { bump, count } = require("./usageCounters");

// Safety ceiling: cap real Razorpay calls per session so recovery churn during testing can't burn
// test-mode rate limits. Not business logic — see .env.example.
const MAX_RAZORPAY_CALLS_PER_SESSION = Number(process.env.MAX_RAZORPAY_CALLS_PER_SESSION) || 50;

// Reuses the same test-mode keys as the order-create debug route. Only paymentLink.create is real;
// auto_retry/alt_method are mocked (see below) — a 1-week buildathon proves the decision logic and
// tracking, not a full notification/re-charge stack.
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// How long a mocked strategy sits at `pending` before resolving to success/failed.
// Short so the funnel visibly moves during a live demo. Override via env if needed.
// (env key kept as AUTO_RETRY_RESOLVE_MS for back-compat; now also governs alt_method.)
const MOCK_RESOLVE_MS = Number(process.env.AUTO_RETRY_RESOLVE_MS) || 4000;

// ponytail: mocked outcomes for the strategies without a real external callback. Real path would
// re-charge / confirm via Razorpay and set the outcome from the API response; upgrade here if that
// lands. auto_retry ~60% (transient retry often works); alt_method ~50% (last resort — see phase-5-orchestration.md).
const MOCK_RESOLUTION = {
  auto_retry: {
    successRate: 0.6,
    success: "Auto-retry succeeded — payment recovered",
    fail: "Auto-retry failed after re-attempt — escalate to payment link",
  },
  alt_method: {
    successRate: 0.5,
    success: "Alternate method succeeded — payment recovered",
    fail: "Alternate method failed — no further recovery path",
  },
};

// Pure (no I/O): the initial recovery_attempts row for a strategy, before any external call.
// Kept side-effect-free so it's unit-testable and the strategy→row map can't silently drift.
function initialAttempt(strategy) {
  switch (strategy) {
    case "auto_retry":
      return { strategy, status: "pending", notes: "Auto-retry scheduled — would re-attempt the charge after a short delay" };
    case "payment_link":
      return { strategy, status: "pending", notes: "Would send a payment link to the customer" };
    case "alt_method":
      return { strategy, status: "pending", notes: "Would suggest an alternate payment method (UPI / net-banking)" };
    default:
      // Unknown/absent strategy still gets a row so the funnel stays complete and the gap is visible.
      return { strategy: strategy || "unknown", status: "pending", notes: `Unrecognized strategy "${strategy}" — logged for review` };
  }
}

// Real Razorpay Payment Link. Returns the note to store (with the short_url on success, or the
// failure reason on error). Never throws — a link failure must not sink the recovery row.
async function createPaymentLinkNote(payment) {
  // Session ceiling: skip the real API call once hit; recovery row still gets a note so the funnel stays complete.
  if (count("razorpay") >= MAX_RAZORPAY_CALLS_PER_SESSION) {
    console.warn("[recovery] session Razorpay call limit reached — skipping payment link creation");
    return "Payment link skipped: session Razorpay call limit reached";
  }
  const n = bump("razorpay");
  console.log(`[recovery] razorpay call #${n} this session`);
  try {
    const link = await razorpay.paymentLink.create({
      amount: payment.amount, // Razorpay webhook entity amount is already in paise
      currency: payment.currency || "INR",
      description: `Retry payment for ${payment.order_id || payment.id}`,
      reference_id: `rec_${payment.id}`, // unique per payment → idempotent on re-create
      reminder_enable: true,
    });
    console.log(`[recovery] payment_link created for ${payment.id}: ${link.short_url}`);
    return `Payment link sent: ${link.short_url}`;
  } catch (err) {
    const msg = err && err.error && err.error.description ? err.error.description : err.message;
    console.error(`[recovery] payment_link API failed for ${payment.id}: ${msg}`);
    return `Payment link creation failed: ${msg}`;
  }
}

// Insert one recovery_attempts row; returns its id (or null on failure — always logged).
async function insertAttempt(paymentId, row) {
  const { data, error } = await supabase
    .from("recovery_attempts")
    .insert({ payment_id: paymentId, ...row })
    .select("id")
    .single();
  if (error) {
    console.error(`[recovery] failed to insert ${row.strategy} attempt for payment ${paymentId}: ${error.message}`);
    return null;
  }
  console.log(`[recovery] logged ${row.strategy} attempt ${data.id} (status=${row.status}) for payment ${paymentId}`);
  return data.id;
}

// Mocked async resolution for a strategy without a real external callback (auto_retry, alt_method).
// After updating the row, invokes onResolve(outcome) so the orchestrator can react (escalate / mark
// lost). Unref'd timer — never holds the process open just for a mocked outcome.
function scheduleMockedResolution(strategy, attemptId, payment, onResolve) {
  console.log(`[recovery] ${strategy} ${attemptId} pending — resolving in ${MOCK_RESOLVE_MS}ms`);
  const timer = setTimeout(() => {
    resolveMocked(strategy, attemptId, payment, onResolve).catch((err) =>
      console.error(`[recovery] ${strategy} resolution crashed for ${attemptId}: ${err.message}`)
    );
  }, MOCK_RESOLVE_MS);
  if (timer.unref) timer.unref();
}

async function resolveMocked(strategy, attemptId, payment, onResolve) {
  const cfg = MOCK_RESOLUTION[strategy];
  const succeeded = Math.random() < cfg.successRate;
  const update = succeeded
    ? { status: "success", recovered_amount: payment.amount / 100, notes: cfg.success }
    : { status: "failed", notes: cfg.fail };
  const { error } = await supabase.from("recovery_attempts").update(update).eq("id", attemptId);
  if (error) {
    console.error(`[recovery] ${strategy} status update failed for ${attemptId}: ${error.message}`);
    return;
  }
  console.log(`[recovery] ${strategy} ${attemptId} resolved → ${update.status}`);
  if (onResolve) onResolve(update.status); // 'success' | 'failed' — orchestrator reacts (never throws here)
}

/**
 * Act on a strategy: create exactly one recovery_attempts row and kick off its mocked/real action.
 * Fire-and-forget — called after the webhook has already 200'd, so it never blocks the response.
 * Never throws (guards its own I/O).
 * @param {string} paymentId  payments.id (uuid)
 * @param {{ id: string, amount: number, currency?: string, order_id?: string }} payment  Razorpay entity (amount in paise)
 * @param {string} strategy  strategy to run (initial classification, or one the orchestrator escalated to)
 * @param {(outcome: 'success'|'failed') => void} [onResolve]  called when a mocked strategy resolves,
 *   so the orchestrator can escalate/terminate. Not invoked for payment_link (resolves out of band).
 * @returns {Promise<string|null>}  the new attempt's id, or null if the insert failed (already logged).
 */
async function executeRecovery(paymentId, payment, strategy, onResolve) {
  try {
    const row = initialAttempt(strategy);

    if (row.strategy === "payment_link") {
      row.notes = await createPaymentLinkNote(payment);
    }

    const attemptId = await insertAttempt(paymentId, row);
    if (!attemptId) return null; // insert failed and was logged; nothing more to do

    if (MOCK_RESOLUTION[row.strategy]) {
      scheduleMockedResolution(row.strategy, attemptId, payment, onResolve);
    }
    return attemptId;
  } catch (err) {
    console.error(`[recovery] execution failed for payment ${payment && payment.id}: ${err.message}`);
    return null;
  }
}

module.exports = { executeRecovery, initialAttempt };
