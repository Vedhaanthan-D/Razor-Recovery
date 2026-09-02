require("dotenv").config();
const Razorpay = require("razorpay");
const { supabase } = require("../config/supabase");
const { bump, count } = require("./usageCounters");

// Safety ceiling: cap real Razorpay calls per session so recovery churn during testing can't burn
// test-mode rate limits. Not business logic — see .env.example.
const MAX_RAZORPAY_CALLS_PER_SESSION = Number(process.env.MAX_RAZORPAY_CALLS_PER_SESSION) || 50;

// Reuses the same test-mode keys as the order-create debug route. Only paymentLink.create is real;
// auto_retry/alt_method are simulated (see below) — they never fabricate a recovered amount, so the
// only verified "success" is a real paid payment link. A 1-week buildathon proves the decision logic
// and tracking, not a full notification/re-charge stack.
//
// Razorpay test mode caps payment_link creation at 30 PER ACCOUNT for the account's lifetime (confirmed:
// once hit, create returns 429 RATE_LIMIT_EXCEEDED "test mode limit of 30 reached for payment_link", and
// cancelling links does NOT free a slot — there's no delete API either). To survive that mid-demo we
// allow a SECOND test account's keys as failover: when the primary can't create a link, we retry on the
// secondary (a fresh 0/30 quota). Both accounts point their webhook at the SAME endpoint; signature
// verification tries both webhook secrets (see lib/signature.js + routes/webhook.js). Configure the 2nd
// pair in .env (RAZORPAY_KEY_ID_2 / RAZORPAY_KEY_SECRET_2); omit it and behaviour is primary-only, as before.
function buildRazorpayClients() {
  return [
    { label: "primary", id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET },
    { label: "secondary", id: process.env.RAZORPAY_KEY_ID_2, secret: process.env.RAZORPAY_KEY_SECRET_2 },
  ]
    .filter((p) => p.id && p.secret)
    .map((p) => ({ label: p.label, client: new Razorpay({ key_id: p.id, key_secret: p.secret }) }));
}

const RAZORPAY_CLIENTS = buildRazorpayClients();

// How long a simulated strategy sits at `pending` before resolving to not-recovered (→ escalate).
// Short so the funnel visibly moves during a live demo. Override via env if needed.
// (env key kept as AUTO_RETRY_RESOLVE_MS for back-compat; now also governs alt_method.)
const MOCK_RESOLVE_MS = Number(process.env.AUTO_RETRY_RESOLVE_MS) || 4000;

// "Only real recoveries count." auto_retry and alt_method have no real external callback in this
// build, so their outcome CANNOT be verified — and an unverifiable outcome must never be reported as
// recovered money. They therefore simulate only the *attempt* (a short pending window so the funnel
// moves live) and then resolve as not-recovered, handing control back to the orchestrator to escalate.
// The ONLY path to `success` is a real, verified signal: the payment_link.paid webhook (an actual
// customer payment, handled in webhook.js). Real path would re-charge / confirm via Razorpay and set
// success from the API response; upgrade here if that lands. See phase-5-orchestration.md / CLAUDE.md.
const SIMULATED_STRATEGIES = {
  auto_retry: { fail: "Auto-retry attempted — recovery not confirmed, escalating to payment link" },
  alt_method: { fail: "Alternate method attempted — recovery not confirmed, no further recovery path" },
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

// Real Razorpay Payment Link, with automatic failover across configured accounts. Returns
// { ok, note }: ok=true + the short_url note on success; ok=false + the failure reason if EVERY
// configured account failed (typically all at the 30-link test cap). Never throws — a link failure
// must not sink the recovery row. `clients` is injectable for tests; defaults to the env-configured list.
async function createPaymentLinkNote(payment, clients = RAZORPAY_CLIENTS) {
  if (!clients.length) {
    console.warn("[recovery] no Razorpay keys configured — skipping payment link creation");
    return { ok: false, note: "Payment link skipped: no Razorpay keys configured" };
  }

  let lastMsg = "no attempt made";
  for (const { label, client } of clients) {
    // Session ceiling: stop once hit; the recovery row still gets a note so the funnel stays complete.
    if (count("razorpay") >= MAX_RAZORPAY_CALLS_PER_SESSION) {
      console.warn("[recovery] session Razorpay call limit reached — skipping payment link creation");
      lastMsg = "session Razorpay call limit reached";
      break;
    }
    const n = bump("razorpay");
    console.log(`[recovery] razorpay call #${n} this session (key=${label})`);
    try {
      const link = await client.paymentLink.create({
        amount: payment.amount, // Razorpay webhook entity amount is already in paise
        currency: payment.currency || "INR",
        description: `Retry payment for ${payment.order_id || payment.id}`,
        reference_id: `rec_${payment.id}`, // unique per payment → idempotent on re-create (per account)
        reminder_enable: true,
      });
      console.log(`[recovery] payment_link created via ${label} key for ${payment.id}: ${link.short_url}`);
      return { ok: true, note: `Payment link sent: ${link.short_url}` };
    } catch (err) {
      const msg = err && err.error && err.error.description ? err.error.description : err.message;
      const capHit = !!(err && (err.statusCode === 429 || (err.error && err.error.code === "RATE_LIMIT_EXCEEDED")));
      lastMsg = msg;
      console.error(
        `[recovery] payment_link via ${label} key failed for ${payment.id}: ${msg}` +
          (capHit ? " — failing over to next account" : "")
      );
      // fall through to the next configured account (if any)
    }
  }
  return { ok: false, note: `Payment link creation failed: ${lastMsg}` };
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
  const cfg = SIMULATED_STRATEGIES[strategy];
  // Unverifiable simulated strategies never self-report success — they resolve as not-recovered and
  // let the orchestrator escalate. Only payment_link.paid (a real payment) ever marks a recovery
  // success, so `recovered_amount` is never fabricated here.
  const update = { status: "failed", notes: cfg.fail };
  const { error } = await supabase.from("recovery_attempts").update(update).eq("id", attemptId);
  if (error) {
    console.error(`[recovery] ${strategy} status update failed for ${attemptId}: ${error.message}`);
    return;
  }
  console.log(`[recovery] ${strategy} ${attemptId} resolved → ${update.status} (not recovered — escalate)`);
  if (onResolve) onResolve(update.status); // always 'failed' — orchestrator escalates (never throws here)
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
      const result = await createPaymentLinkNote(payment);
      row.notes = result.note;
      // No link on ANY account → don't leave a phantom `pending` link that just waits out the timeout.
      // Mark it failed now and escalate immediately (below).
      if (!result.ok) row.status = "failed";
    }

    const attemptId = await insertAttempt(paymentId, row);
    if (!attemptId) return null; // insert failed and was logged; nothing more to do

    if (SIMULATED_STRATEGIES[row.strategy]) {
      scheduleMockedResolution(row.strategy, attemptId, payment, onResolve);
    } else if (row.strategy === "payment_link" && row.status === "failed") {
      // Link couldn't be created (all accounts at cap, or another create error) → escalate straight
      // away via the policy (payment_link onFail → alt_method). The orchestrator still schedules the
      // link timeout, but it will find this row already `failed` and no-op (no double escalation).
      if (onResolve) onResolve("failed");
    }
    return attemptId;
  } catch (err) {
    console.error(`[recovery] execution failed for payment ${payment && payment.id}: ${err.message}`);
    return null;
  }
}

module.exports = { executeRecovery, initialAttempt, createPaymentLinkNote };
