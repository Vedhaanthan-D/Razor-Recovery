# Demo Script — Razor Recovery

*Live-demo runbook for recording the Buildathon pitch video. Rehearse once against this before hitting record.*

## Setup before recording

- **Env vars** (`Backend/.env`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, plus all three LLM keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`). Sanity-check with `GET /api/health` → `{ status: 'ok', db: 'connected' }`.
- **Servers up:** `npm run dev:backend` (→ `:3000`) and `npm run dev:frontend` (→ `:5173`) in two terminals.
- **Tunnel up:** `npx ngrok http 3000`, then point the Razorpay webhook at `<ngrok-url>/api/webhook/razorpay` (events: `payment.failed`, `payment_link.paid`). Confirm the tunnel is live before recording.
- **Warm the dashboard:** open `http://localhost:5173/` once so the Insights summary is cached and paints instantly on camera.
- **Sandbox caveat:** Razorpay test cards are frequently flagged `international: true` and blocked at initiation. Have a known-working test card ready, or fall back to the signed injection harness (`node Backend/scripts/inject.js failed`) to guarantee a clean `payment.failed` on demand.

## Demo sequence

1. **Trigger a failure** — go to `/checkout`, start a test-mode payment, let it fail. *"A real Razorpay `payment.failed` webhook just fired at our endpoint."*
2. **Show classification** — open `/agents` (Recovery Journeys), newest payment on top. Point at the Classification agent's `reason` + one-line `detail` + `confidence`; note the Verifier's independent second opinion kicks in only when confidence is low.
3. **Show the escalation chain** — expand that payment's journey: the deterministic orchestrator walks `auto_retry → payment_link → alt_method`, marking `lost` only if the whole chain is exhausted. Call out the hard guardrail: a `card_expired` / `card_invalid` failure can *never* be assigned `auto_retry`.
4. **Show the funnel update** — back to `/` (dashboard): the funnel, money recovered vs. lost, and the by-reason / by-strategy breakdowns now include the payment you just triggered.
5. **Show Insights** — read the plain-English Insights summary at the top of the dashboard, then type a question into "ask about this data" to show bounded Q&A over the same aggregate.

## What broke and how we fixed it

Pull these from [`phase-4.md`](phase-4.md) — the failure-injection log — and narrate each as *"we deliberately broke it, then hardened it."*

1. **Duplicate webhook storm → 500 instead of 200.** Firing the same signed event concurrently raced two inserts; the loser's Postgres `23505` surfaced *without* `error.code` populated, so the handler missed it and returned 500 — which makes Razorpay keep retrying. **Fix:** detect the duplicate by error *message*, not just code — every re-delivery now returns `200 {duplicate:true}`.
2. **Malformed payload → process crash.** A correctly-signed event with a missing `payload.payment.entity` crashed the server on raw nested field access. **Fix:** defensive `parseFailedPayment()` — a broken payload returns `400` and never takes the process down.
3. **Killed mid-classification → orphaned payment.** Killing the backend in the window between the `200` ack and classification completing left a `payments` row with no classification. **Fix:** a manual reconciliation sweep, `POST /api/debug/reclassify?minAgeSec=60`, finds and re-classifies orphans.

*Bonus resilience points if asked:* all three LLM providers down degrades to a safe default (`reason: other`, `suggested_strategy: payment_link`) rather than failing the payment; and `MAX_LLM_CALLS_PER_SESSION` caps runaway quota drain during a storm.
