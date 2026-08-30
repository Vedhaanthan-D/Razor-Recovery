# CLAUDE.md

Project context for AI coding assistance. Read this before making changes.

## Project

**Recovery Agent** — AI-powered payment recovery system for Razorpay AI Buildathon (Track 3: AI Revenue Recovery).

An agent that listens to failed Razorpay payment webhooks, classifies the failure reason using an LLM, picks a recovery strategy, and tracks outcomes on a dashboard.

## Current version

**v1.2.0** — Phase 1, 2, and 3 complete and verified. Phase 4 (failure injection testing) starting.

## Tech stack (as actually built)

- Frontend: React + Vite, proxies `/api` → backend
- Backend: Node.js + Express, **JavaScript / CommonJS** (deviated from TS — see phase-1.md)
- Database: Supabase (Postgres), RLS enabled with read-only anon policy
- LLM: Groq (primary + backup key) → Mistral (fallback), 3-way chain in `classificationService.js`
- Payments: Razorpay test-mode APIs + webhooks
- Tunnel (dev only): ngrok

## Folder structure (actual)

```
/Backend
  /src
    /lib          -> signature verification util (testable)
    /routes       -> webhook.js, health.js, test/create-order.js (debug)
    /services     -> classificationService.js
    server.js
  .env.example
/frontend
  /src
    /pages        -> PaymentsDebug.jsx, TestCheckout.jsx
    /lib          -> supabaseClient.js
```

## Environment variables

See `.env.example` in both `/Backend` and `/frontend`. Never commit `.env`.

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
GROQ_API_KEY_2=
GROQ_MODEL=
GROQ_MODEL_2=
MISTRAL_API_KEY=
MISTRAL_MODEL=
```

Frontend also needs `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

## Conventions

- All DB access goes through a single Supabase client instance (backend: service_role key; frontend: anon key, read-only).
- All Razorpay webhook signatures verified (HMAC-SHA256, timing-safe compare) before any processing.
- Duplicate webhook deliveries (same `razorpay_payment_id`) are caught via unique constraint + Postgres error `23505`, return 200 so Razorpay stops retrying.
- Classification never blocks or fails the webhook response — logged separately, safe default on total provider failure.
- Debug/test-only pages live under `/debug/*` routes and are clearly separated from product UI.
- Commit messages: short, imperative.
- Before assuming a Groq/Mistral model name is valid, verify with `curl .../v1/models` — model availability varies by account and changes without much warning (hit this in Phase 2).

## Phase status

- [x] Phase 1 — DB connection, schema, webhook (signature verify, insert, dedupe), health check, debug tooling — verified with a real triggered failure
- [x] Phase 2 — LLM classification wired into webhook → `failure_classifications` — verified end to end (`pay_TSKKzonM0vGpFw` → `invalid_details`, 0.9, `payment_link`, `groq_key1`). Hit and resolved a stale-process bug (edited code wasn't reloaded — restarted with `npm run dev`, not `npm start`).
- [x] Phase 3 — Recovery strategy execution (`auto_retry` mocked, `payment_link` real via Razorpay Payment Links API) + real dashboard UI (funnel, money cards, breakdowns, recent activity with clickable pay link). Verified end to end: real payment link paid with a success test card → `payment_link.paid` webhook → `recovery_attempts` flips to `success` → dashboard `Recovered` moves off ₹0. Found and fixed a real gap along the way — the `payment_link.paid` handler had never actually been wired into `webhook.js` (only the creation side existed); added the missing branch + two-hop match (`reference_id` → `payments.razorpay_payment_id` → `payments.id` → `recovery_attempts`).
- [ ] Phase 4 — Failure injection testing (duplicate webhooks, retry storms, provider outages, malformed payloads)
- [ ] Phase 5 — Demo video + architecture doc + repo cleanup

Full detail per phase: see `phase-1.md`, `phase-2.md`, `phase-3.md`, `phase-4.md`.