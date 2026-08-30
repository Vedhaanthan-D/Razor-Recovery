# Phase 5 — Recovery orchestrator

**Version:** 1.5.0 (target)
**Status:** 🔲 In progress — building incrementally, one verified step at a time
**Depends on:** Phases 1-4 complete, provider chain stable (Nemotron primary confirmed working)

## Why incremental, not one-shot

Async timeout logic + race conditions (a strategy resolving late, after a timeout already escalated it) are exactly the kind of thing that breaks silently if built all at once. Each step below must be verified working — full existing test suite green — before starting the next one.

## What this replaces

**Before:** `classifyAndStore()` picks one `suggested_strategy`, `executeRecovery()` runs it once, done. No matter the outcome, nothing further happens.

**After:** a sequential control-flow layer that reacts to outcomes and escalates through a fixed policy, so a failed `auto_retry` doesn't just die — it tries the next reasonable strategy automatically.

## Important terminology note (for the pitch, and for future-you)

**The orchestrator is NOT itself an AI agent.** It's a deterministic state machine — no LLM call happens inside it. The actual AI reasoning happens once, upfront, in `classificationService.js` (unstructured error → structured decision). The orchestrator just makes sure that decision doesn't dead-end if the first attempt fails, using a fixed policy table (`escalationPolicy.js`), not further LLM judgment.

This is a deliberate, defensible design choice — not a limitation to hide. If asked "where's the AI in the orchestrator," the honest answer ("reasoning happens once at classification; orchestration is plain control flow reacting to that decision") directly demonstrates the "right tool in the right place" judgment criterion, rather than overstating rule-based logic as "agentic."

## Escalation policy

```js
// config/escalationPolicy.js
const ESCALATION_POLICY = {
  auto_retry:   { onFail: 'payment_link', waitSeconds: 30 },
  payment_link: { onTimeout: 'alt_method', timeoutMinutes: 10 },
  alt_method:   { onFail: null } // terminal — no further escalation
};
```

## Build steps

### Step 1 — Pass-through wrapper ✅ done
`orchestratorService.js` created with `runOrchestration(paymentId, payment, initialStrategy)`. `webhook.js` calls this instead of `executeRecovery()` directly. With a non-escalating outcome it's behaviourally identical to the old direct call (one attempt row).
**Verified:** full suite green; `runStrategy` calls `executeRecovery` exactly once for the initial strategy (structural pass-through — no DB mock built, that'd be scaffolding for a structural guarantee).

### Step 2 — `auto_retry` → `payment_link` escalation ✅ done
`executeRecovery()` gained an optional `onResolve(outcome)` callback (default undefined → old behavior). The mocked resolution (now generalized in `recoveryService.js` to cover both mocked strategies) invokes it after updating the row. The orchestrator's `onResolve` escalates on `'failed'` via `ESCALATION_POLICY`, calling `executeRecovery()` again with `payment_link` → a second `recovery_attempts` row.
**Verified:** `nextStrategy('auto_retry','fail') → payment_link` unit-tested; non-auto_retry strategies untouched (payment_link/alt_method have no `onFail` route in the policy). Full suite green.

### Step 3 — `payment_link` timeout → `alt_method` escalation ✅ done
Orchestrator schedules an unref'd `setTimeout(timeoutMinutes)` (via `scheduleLinkTimeout`) keyed on the returned `attemptId`.
- **Race handling (implemented as an atomic compare-and-set on the shared row, not a status re-read + write):** the timeout callback claims the row with `update … set status='failed' where id=A AND status='pending'`; `handlePaymentLinkPaid` claims it with `update … set status='success' where …=payment_link AND status='pending'`. Whichever runs **second** matches 0 rows and no-ops. First terminal writer wins; no incorrect overwrite in either direction (a late link-payment can't un-escalate; a timeout can't un-recover a paid row). Also makes duplicate `payment_link.paid` deliveries idempotent.
**Verified:** `nextStrategy('payment_link','timeout') → alt_method` unit-tested; the CAS race resolution is verified live (needs a real pending row) — narrate from `[orchestrator]`/`[webhook]` logs in the demo.

### Step 4 — Terminal `lost` status ✅ done
`alt_method` is now mocked (~50%, in `recoveryService.js`'s `MOCK_RESOLUTION`). On its `'failed'` outcome the policy's `alt_method.onFail: null` marks it terminal, and `markLost()` sets `payments.status='lost'` (reused the schema's existing status set — no new column, no dashboard-query change). Guarded `!= 'recovered'` so a success can't be clobbered to lost.
**Verified:** `nextStrategy('alt_method','fail') → { next:null, terminal:true }` unit-tested.

### Step 5 — Dashboard adjustments ✅ done (no code change needed)
`dashboard.js`'s `aggregate()` already made both choices correctly: the funnel counts `recovery_attempted`/`recovered` **per-payment** (`if (attempts.length)` / any success — an escalated payment counts once), and the strategy table counts **per-attempt** (raw, iterating each attempt). Rather than rewrite working code, a `dashboard.test.js` block now pins this against a 2-attempt escalated-and-recovered payment and a 3-attempt exhausted-and-lost chain.
**Verified:** new escalation assertions green.

## Acceptance criteria

- [x] Each step above verified independently before starting the next (pure decision logic unit-tested per step)
- [x] Full existing test suite (all phases) stays green throughout — 7/7 suites pass (added `orchestratorService.test.js`)
- [ ] At least one full escalation chain demonstrated live: trigger a failure classified as `network_timeout` → mocked auto_retry fails → payment_link auto-generated → let it time out → escalates to `alt_method` → terminal status set. **(Demo-time step — see "How to demo the live chain" below.)**
- [x] Orchestrator log trail (`[orchestrator] payment <id>: ...`) is clean and readable — narrate directly from these logs in the pitch video
- [x] Design decisions / notes recorded (below)

## Implementation notes & decisions (built this phase)

- **Race resolution = atomic compare-and-set, not read-then-write.** Both the `payment_link` timeout and the `payment_link.paid` handler do a conditional `UPDATE … WHERE status='pending'` and check rows-affected. This is race-free by construction (Postgres serializes the two updates on the row) — a plain "re-check status then write" would still have a TOCTOU window. First terminal writer wins; second no-ops.
- **`waitSeconds` omitted from the policy.** The original spec had `auto_retry: { …, waitSeconds: 30 }`; dropped it — auto_retry already sits at `pending` for its mocked resolve delay, and idling another 30s before escalating only hurts the demo. Knob left as a comment in `escalationPolicy.js` if real backoff is ever needed.
- **`lost` reuses `payments.status`** (already in the schema's documented set) — no new column, no dashboard-query change. `markLost` guards `!= 'recovered'`.
- **Step 5 needed no dashboard code change** — `aggregate()` already counted per-payment (funnel) and per-attempt (strategy). Pinned with a test instead of rewritten.
- **In-memory timers** (auto_retry resolve, payment_link timeout) are lost on restart — same accepted limitation as the existing mocked strategies; a durable queue is out of scope (see "What NOT to do"). The reconciliation sweep already covers the orphan class.
- **Live-only paths:** the timer-fired escalation, the CAS race, and the terminal `lost` write all require real DB rows, so they're validated live (below), not in the pure unit tests.

## How to demo the live chain

1. Shorten the timeout: set `PAYMENT_LINK_TIMEOUT_MINUTES=0.15` (≈9s) in `Backend/.env`, restart with `npm run dev`.
2. Inject a transient failure that classifies to `auto_retry`:
   `node scripts/inject.js failed --code GATEWAY_ERROR --desc "network timeout at gateway"`
3. Watch the `[orchestrator]`/`[recovery]` logs: auto_retry pending → (if it fails) escalate to payment_link → (unpaid) timeout → alt_method → (if it fails) `marked lost`. Dashboard funnel/strategy table update live.
   (Mocked rates: auto_retry 60% ok, alt_method 50% ok — re-run a few times to see each branch.)

## What NOT to do

- Don't make the orchestrator itself call an LLM to decide escalation — that's a bigger, riskier redesign with lower payoff than described in the "why incremental" section above. If there's spare time after Phase 5 is fully done and verified, this could be a "stretch" addition — but the static policy table is the safer, more defensible default.
- Don't build a real job scheduler/queue for the timeout logic — the unref'd setTimeout pattern already used elsewhere in this codebase is sufficient and consistent with existing conventions.

## Next: remaining Phase 5 items (post-orchestrator)

Swagger/OpenAPI docs, architecture diagram, ADRs (why Supabase, why fire-and-forget, why 3-tier fallback), classification eval set (hand-labeled test cases + accuracy %), demo video script (build from `docs/failures.md` + orchestrator logs), final cleanup (strip debug `console.log` dumps, confirm `.env` gitignored, tidy README).