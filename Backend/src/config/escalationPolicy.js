// Escalation policy: the fixed table the orchestrator (orchestratorService.js) walks when a recovery
// strategy's async outcome resolves. This is NOT AI — it's a deterministic state machine. The LLM
// reasoning happens once, upstream, in classificationService.js (unstructured error → structured
// decision); this table just prevents that first decision from dead-ending if the attempt fails.
//
//   auto_retry   fails                 -> payment_link  (send the customer a link to complete the charge)
//   payment_link times out (unpaid)    -> alt_method    (suggest UPI / net-banking)
//   payment_link cannot be created     -> alt_method    (every Razorpay account at its 30-link test cap)
//   alt_method   fails                 -> terminal      (payment marked 'lost' — genuinely unrecoverable)
//
// ponytail: the original spec's `waitSeconds` (pre-escalation backoff) is omitted — auto_retry already
// sits at `pending` for its own mocked resolve delay (recoveryService), and a demo shouldn't idle an
// extra 30s before escalating. Add a per-strategy pre-escalation wait here if a real deployment needs it.

// Demo knob: the real timeout is 10 min, far too long to show live. Override via env to shorten for a demo.
const PAYMENT_LINK_TIMEOUT_MINUTES = Number(process.env.PAYMENT_LINK_TIMEOUT_MINUTES) || 10;

const ESCALATION_POLICY = {
  auto_retry: { onFail: "payment_link" },
  // onTimeout: the link was sent but went unpaid within the window. onFail: the link could NOT be
  // created at all (e.g. every configured Razorpay account hit its 30-link test cap) — no point
  // waiting out a timeout on a link that was never sent, so escalate straight to alt_method.
  payment_link: { onFail: "alt_method", onTimeout: "alt_method", timeoutMinutes: PAYMENT_LINK_TIMEOUT_MINUTES },
  alt_method: { onFail: null }, // terminal — no further escalation
};

module.exports = { ESCALATION_POLICY };
