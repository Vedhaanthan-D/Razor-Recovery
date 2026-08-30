# Phase 3 — Recovery execution + dashboard

**Version:** 1.2.0 (target)
**Status:** ✅ Code complete + unit-verified — recovery execution wired into the pipeline (`recoveryService.js`), `GET /api/dashboard` aggregates the funnel, real dashboard UI shipped. `/api/dashboard` verified against live DB; backend self-checks green. **Pending:** one live end-to-end trigger (new failed payment via ngrok → recovery row + real payment link) — the live DB rows predate Phase 3, so recovery hasn't fired on real traffic yet. Same manual verification step Phases 1–2 used.
**Depends on:** Phase 2 complete (verified — classification lands correctly, e.g. `pay_TSKKzonM0vGpFw` → `invalid_details`, 0.9, `payment_link`, `groq_key1`)

## Goal

Act on the `suggested_strategy` from Phase 2, log the outcome to `recovery_attempts`, and replace the debug table with an actual dashboard showing the recovery funnel — this is the visual centerpiece for your demo.

## Part A — Recovery strategy execution (backend)

For a 1-week buildathon scope, **mock the actual delivery** (no real SMS/email/payment gateway integration) — the goal is to prove the *decision logic and tracking*, not build a notification system.

### Behavior

After a classification is stored (extend `classifyAndStore`, or trigger from a new step right after), route on `suggested_strategy`:

| Strategy | Mocked action | Outcome logged |
|---|---|---|
| `auto_retry` | Log "would retry payment after delay" (optionally: actually re-attempt via Razorpay API using stored order details, if time allows) | `recovery_attempts` row: `status: 'pending'` → simulate resolving to `success`/`failed` after a short delay |
| `payment_link` | Log "would send payment link to customer" (generate a real Razorpay Payment Link via their API — this part is real and cheap to implement, adds credibility) | `recovery_attempts` row: `status: 'pending'`, note the generated link |
| `alt_method` | Log "would suggest alternate payment method" | `recovery_attempts` row: `status: 'pending'`, notes the suggestion |

### Schema (already exists from Phase 1, confirm in use)

```sql
recovery_attempts (
  id, payment_id, strategy, status, recovered_amount, notes, attempted_at
)
```

### Acceptance criteria — Part A

- [x] Every classified payment gets exactly one `recovery_attempts` row, matching its `suggested_strategy`
- [x] No duplicate recovery attempts on webhook re-delivery
- [x] Recovery logic never blocks or fails the webhook response (same fire-and-forget pattern as classification)
- [x] At least one strategy path (`payment_link` recommended) does something real — actually calls Razorpay's Payment Links API — for demo credibility

## Part B — Real dashboard UI (frontend)

Replace `/debug/payments` as the primary view (keep it around for debugging, but this is what you demo).

### What it shows

1. **Funnel**: Failed → Classified → Recovery attempted → Recovered (counts at each stage)
2. **$ recovered** vs **$ lost** (sum of `recovered_amount` vs sum of failed `amount` with no successful recovery)
3. **Breakdown by failure reason** (simple bar or table — which reasons are most common)
4. **Breakdown by strategy** (which strategy gets used most, and its success rate)
5. **Recent activity table** (last N failed payments with their full pipeline status — reuse logic from `/debug/payments` but styled properly)

### Acceptance criteria — Part B

- [x] Dashboard reads live — via `GET /api/dashboard` (backend service_role, same proven pattern as `/api/test/payments`). **Deviation:** the spec said anon key direct-to-Supabase, but the existing debug page already reads through the backend, so the dashboard follows that (server-side aggregation, no anon RLS dependency). `supabaseClient.ts` stays for future direct reads.
- [x] Funnel numbers accurate against the DB — verified: live `/api/dashboard` returned `failed:5, classified:1`, `lost:52500` (= sum of the 5 real failed amounts), `by_reason: invalid_details×1`, matching the actual rows.
- [x] Loads without errors on an empty DB (zero-state message, `aggregate([])` unit-tested)
- [x] Visually presentable — themed cards, funnel bars, breakdowns, recent-activity table, 5s live poll so `auto_retry` resolutions animate during the demo

## Build notes (what was actually built)

**Backend**
- `services/recoveryService.js` — `executeRecovery(paymentId, payment, strategy)` routes on strategy, inserts exactly one `recovery_attempts` row, logs every step (`[recovery] …`). `payment_link` → **real** `razorpay.paymentLink.create` (paise, `reference_id: rec_<payment_id>` for idempotency), stores the `short_url` in `notes`. `auto_retry` → `pending`, then a `setTimeout` (`AUTO_RETRY_RESOLVE_MS`, default 4s, `.unref()`) resolves to `success`/`failed` (mocked ~60% — `ponytail:` upgrade path noted). `alt_method` → `pending` note. Never throws.
- `routes/webhook.js` — `classifyAndStore` now calls `executeRecovery` off the in-memory classification result (so a classification-store hiccup doesn't skip recovery). Still fire-and-forget after the 200. No-duplicate is inherited from the existing webhook dedup (recovery only runs on first insert).
- `routes/dashboard.js` — `GET /api/dashboard`, one embedded query (payments + classifications + attempts), pure `aggregate()` for funnel / money / by-reason / by-strategy / recent. Logs `[dashboard] query failed` on error.

**Frontend**
- `App.tsx` is now the product dashboard (was the Vite starter). Debug pages untouched (`/debug/payments`, `/debug/checkout`). `App.css` restyled off the existing theme vars (light/dark).

**Self-checks (no framework):** `npm run test:recovery` (strategy→row map), `npm run test:dashboard` (funnel + money math incl. empty DB) — both green, plus existing `test`/`test:webhook`.

**Ceilings left (ponytail):** no reconciliation sweep if the process dies mid-recovery (Phase 4); `auto_retry` outcome is mocked, not a real re-charge; `by_strategy` counts attempts, one payment could in theory have multiple attempt rows (doesn't happen given the one-attempt-per-payment path).

**Ops footgun (again):** a stale `node --watch` on port 3000 serves old code / blocks a fresh `node src/server.js` with `EADDRINUSE`. Kill the PID from `netstat -ano | grep :3000` before assuming code didn't reload.

## What's explicitly out of scope for Phase 3

- Real SMS/email delivery integration
- Real automatic payment retry via saved card (Razorpay tokenization) — mock this one
- Auth/login on the dashboard (not needed for a demo)

## Next: Phase 4

Failure injection testing — duplicate webhook storms, provider timeouts, malformed payloads, killing the process mid-classification. This becomes your "what broke and how you fixed it" story for the panel interview.