# CLAUDE.md

Project context for AI coding assistance. Read this before making changes.

## Project

**Recovery Agent** — AI-powered payment recovery system for the Razorpay AI Buildathon
(Track 3: AI Revenue Recovery).

Listens to failed Razorpay payment webhooks, classifies the failure reason using an LLM,
picks a recovery strategy, executes and escalates it, and tracks outcomes on a live
dashboard.

## Tech stack

- Backend: Node.js + Express, **JavaScript / CommonJS** (a deliberate deviation from an
  earlier TypeScript plan — matches the existing `server.js`, avoided toolchain churn
  mid-sprint; see `docs/phase-1.md`)
- Frontend: React + Vite + TypeScript, path-based routing (`main.tsx`), no router library
- Database: Supabase (Postgres), RLS enabled — anon key is read-only, service_role key
  (backend only) can write
- LLM classification chain: **OpenRouter/Nemotron (primary)** → Groq → Mistral → safe
  default, with a 10-minute in-memory cache and a per-session call ceiling
  (`MAX_LLM_CALLS_PER_SESSION`)
- Payments: Razorpay test-mode APIs + webhooks (`payment.failed`, `payment_link.paid`)

## Folder structure — the split that matters

```
Backend/src/
  agents/      ← the AI decision-makers. Each one reasons over input and produces a
                 judgment call. Never called "services".
    classificationService.js   why did this fail? -> { reason, detail, confidence, suggested_strategy }
    verifierService.js         confidence-weighted consensus: a second, independent
                                classifier call, ONLY when confidence < 0.5
    strategyAdvisorService.js  reweights the suggested strategy against REAL historical
                                recovery outcomes for that failure reason
    insightsService.js         plain-English summary of the dashboard aggregate; also
                                answers bounded Q&A over that same data

  services/    ← deterministic infrastructure. No LLM call happens in this folder.
    orchestratorService.js  a fixed state machine: which recovery step runs next, and
                             when to escalate. NOT an agent — see "Terminology" below.
    recoveryService.js      executes one attempt (auto_retry / payment_link / alt_method)
    usageCounters.js         in-memory per-session LLM + Razorpay call counters

  routes/
    webhook.js     POST /api/webhook/razorpay — signature verify, store, fire-and-forget
                   classify -> verify -> advise -> orchestrate -> recover
    dashboard.js   GET /api/dashboard — funnel / money / by-reason / by-strategy / recent
    insights.js    GET /api/insights, POST /api/insights/ask
    health.js      GET /api/health
    test.js        debug-only routes, mounted under /api/debug (not /api)

  config/
    supabase.js          shared service_role client
    escalationPolicy.js  the fixed auto_retry -> payment_link -> alt_method table

  lib/
    signature.js  Razorpay webhook HMAC-SHA256 verification (timing-safe compare)

Backend/scripts/inject.js   Phase 4 failure-injection harness — signs and fires webhooks
                            directly at localhost (duplicate storms, malformed payloads)
Backend/db/schema.sql       idempotent (`add column if not exists`) — safe to re-run

frontend/src/
  pages/
    RecoveryJourneys.tsx  /agents — per-payment trace: classify -> verify -> advise ->
                          recovery escalation chain, collapsed-by-default with expand
    Architecture.tsx      /how-it-works — pipeline overview, the four agents, guardrails
    TestCheckout.tsx      /checkout — trigger a real Razorpay test-mode failed payment
    PaymentsDebug.tsx     /debug/payments — raw utilitarian table, deliberately unthemed
  components/
    JourneyTracker.tsx  the shipment-tracking-style visual for one payment's recovery path
    InsightsPanel.tsx   AI summary banner + "ask about this data" Q&A input
    Layout.tsx, StatusPill.tsx
  App.tsx    the main dashboard (/) — funnel, money cards, breakdowns, recent activity
```

## Terminology — precision matters for the pitch

**`agents/` vs `services/` is not a cosmetic split.** An agent decides *what* to do; a
service *does* it.

- `classificationService.js`, `verifierService.js`, `strategyAdvisorService.js`,
  `insightsService.js` — these are the actual AI agents. Each makes an LLM call or a
  judgment call based on data.
- `orchestratorService.js` is **deliberately not an agent**. It is a deterministic state
  machine sequencing a fixed policy table (`escalationPolicy.js`). No LLM call happens
  inside it. This is a considered design choice, not a limitation: a system that recovers
  money benefits from auditable, predictable control flow more than from a free-form
  reasoning loop deciding what to do next. If asked "where's the AI in the orchestrator,"
  the honest answer — reasoning happens once, upstream, at classification/verification/
  advice; orchestration just prevents that decision from dead-ending — is itself a good
  answer, not something to talk around.

Do not describe the orchestrator as "agentic" in docs, the pitch, or code comments.

## Classification taxonomy

`reason` enum: `insufficient_funds, bank_decline, card_expired, card_invalid,
network_timeout, domestic_only_restriction, currency_mismatch, authentication_failed,
limit_exceeded, other`

Each classification also returns `detail` — a one-sentence plain-language explanation, not
a restated enum label.

**Hard-coded invariant** (`banCardAutoRetry()` in `classificationService.js`, enforced in
`parseAndValidate` — holds even if the LLM ignores prompt guidance): `card_expired` and
`card_invalid` can never be assigned `auto_retry`. Retrying the same bad card can't
succeed, so this is code, not a suggestion.

## Guardrails (deterministic, hold regardless of LLM output)

- `banCardAutoRetry()` — see above.
- `MAX_LLM_CALLS_PER_SESSION` (default 100) and `MAX_RAZORPAY_CALLS_PER_SESSION` (default
  50) in `usageCounters.js` — a runaway loop (e.g. a webhook storm) cannot silently drain
  free-tier quota; once the ceiling is hit, calls are skipped and a safe default is
  returned instead.
- Strategy Advisor's decision rule (`strategyAdvisorService.js`): fewer than `MIN_SAMPLE`
  (5) historical attempts for a reason → trust the classifier's default, don't override on
  thin data. A rival strategy needs to beat the default by at least `MIN_EDGE` (20
  percentage points) to be swapped in.

## Conventions

- All DB access goes through one Supabase client instance per side (backend: service_role;
  frontend: anon, read-only).
- Every Razorpay webhook signature is verified (HMAC-SHA256, timing-safe compare) before
  any processing. A duplicate delivery (unique constraint + Postgres `23505`, matched by
  error **message**, not just code — a race under concurrent duplicates was found
  returning 500 instead of 200; see `docs/phase-4.md`) always returns `200 {duplicate:true}`.
- Malformed payloads (valid signature, missing/broken nested fields) are parsed
  defensively via `parseFailedPayment()` — this must never crash the process. Returns
  `400`, not a 500 (Phase 4 finding — this used to crash the server outright).
- Classification, verification, advice, and recovery all run **fire-and-forget after the
  webhook's 200 ack** — LLM latency must never risk Razorpay's webhook timeout, and a
  provider failure must never fail the payment write.
- Agents never throw on the webhook path. A total provider outage degrades to
  `{ reason: 'other', confidence: 0, suggested_strategy: 'payment_link' }` rather than
  failing anything.
- The Verifier only makes its (independent, different-provider) call when
  `confidence < 0.5` — otherwise it's a no-op, logged as skipped, no API call spent.
- Orphaned payments (process killed mid-classification, before the fire-and-forget
  completes) are healed via `POST /api/debug/reclassify?minAgeSec=60` — a manual
  reconciliation sweep, not a scheduler (deliberately out of scope for the timeline).
- Debug-only routes are mounted under `/api/debug`, not `/api` — keep this namespace
  separation; don't add new debug routes to the main `/api` prefix.
- Before assuming a Groq/OpenRouter model name or JSON-mode config is valid, verify
  against the provider's live model list — availability and JSON-mode requirements vary by
  account and change without warning (hit real bugs from this twice: a Groq model
  deprecation, and a `usageCounters.js` naming desync after a provider rename that silently
  stopped 2 of 3 providers from counting toward the session ceiling).
- **Known Razorpay sandbox limitation**: this test account flags most test card numbers as
  `international: true` → blocked at `payment_initiation` before other failure modes can
  trigger. Full reason-taxonomy coverage is validated via each agent's own `*.test.js`
  (synthetic inputs), not live Razorpay traffic — mention this distinction if asked about
  data variety in a live demo.

## Testing

Every non-trivial module ships a co-located `*.test.js` using plain `node:assert` — no test
framework dependency. Run the whole suite with `npm test` from the repo root (delegates to
`Backend && npm test`, which chains every suite). `Backend/scripts/inject.js` sends signed
webhooks directly at a running server to reproduce duplicate storms, malformed payloads,
provider outages, and quota exhaustion on demand.

## Where the full history lives

`docs/` holds the phase-by-phase build log as flat files: `phase-1.md` through
`phase-4.md`, plus `phase-5-orchestration.md` for the recovery orchestrator and
`DEMO_SCRIPT.md`, the live-demo runbook. `docs/phase-4.md` is the failure-injection
log — what broke and how it was fixed. There is no `docs/failures.md`; that content
lives in `docs/phase-4.md`, as the root README notes.
