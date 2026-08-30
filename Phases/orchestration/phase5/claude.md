# CLAUDE.md

Project context for AI coding assistance. Read this before making changes.

## Project

**Recovery Agent** — AI-powered payment recovery system for Razorpay AI Buildathon (Track 3: AI Revenue Recovery).

Listens to failed Razorpay payment webhooks, classifies the failure reason using an LLM, picks a recovery strategy, executes it, and tracks outcomes on a live dashboard.

## Current version

**v1.5.0** — Phases 1-4 complete and verified. Orchestrator (sequential recovery escalation) built and unit-verified; full live chain is a demo-time step.

## Tech stack (as actually built)

- Frontend: React 19 + Vite + TypeScript, proxies `/api` → backend, path-based routing (no router lib)
- Backend: Node.js + Express, **JavaScript / CommonJS** (deviated from original TS plan — see phase-1.md)
- Database: Supabase (Postgres), RLS enabled with read-only anon policy
- LLM classification chain: **OpenRouter/Nemotron-3-Ultra-550B (primary)** → Groq key1 → Mistral → safe default
- Payments: Razorpay test-mode APIs + webhooks (`payment.failed`, `payment_link.paid`)
- Tunnel (dev only): ngrok

## Folder structure (actual)

```
/Backend
  /src
    /config       -> supabase.js, escalationPolicy.js
    /lib          -> signature verification util (testable)
    /routes       -> webhook.js, health.js, dashboard.js, test.js (debug)
    /services     -> classificationService.js, recoveryService.js,
                      usageCounters.js, orchestratorService.js (in progress)
    server.js
  /scripts        -> inject.js (failure-injection test harness)
  /db             -> schema.sql
  .env.example
/frontend
  /src
    /pages        -> PaymentsDebug.tsx, TestCheckout.tsx
    /lib          -> supabaseClient.ts
    App.tsx       -> main dashboard (funnel, money cards, breakdowns, recent activity)
/docs
  failures.md     -> Phase 4 failure-injection log (demo/panel source material)
```

## Environment variables

See `.env.example` in both `/Backend` and `/frontend`. Never commit `.env` — rotate any key that's ever been shared/screenshotted.

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
GROQ_API_KEY=
GROQ_MODEL=
MISTRAL_API_KEY=
MISTRAL_MODEL=
MAX_LLM_CALLS_PER_SESSION=100
MAX_RAZORPAY_CALLS_PER_SESSION=50
```

Frontend also needs `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

## Classification taxonomy (expanded)

`reason` enum: `insufficient_funds, bank_decline, card_expired, card_invalid, network_timeout, domestic_only_restriction, currency_mismatch, authentication_failed, limit_exceeded, other`

Each classification also returns `detail` (one-sentence plain-language explanation, shown as a hover tooltip in Recent Activity — not just a restated enum label).

**Hard-coded strategy invariant** (enforced in `parseAndValidate`, not just prompted — holds even if the LLM ignores guidance): `card_expired` and `card_invalid` can never be assigned `auto_retry` (retrying with the same bad card can't succeed) — always routed to `payment_link` or `alt_method` instead.

## Conventions

- All DB access goes through a single Supabase client instance (backend: service_role key; frontend: anon key, read-only).
- All Razorpay webhook signatures verified (HMAC-SHA256, timing-safe compare) before any processing.
- Duplicate webhook deliveries caught via unique constraint + Postgres error `23505` **matched by message, not just error code** (a race under concurrent duplicates was found returning 500 instead — fixed in Phase 4) — always returns 200 `{duplicate:true}`.
- Malformed payloads (valid signature, missing/broken nested fields) are parsed defensively via `parseFailedPayment()` — never crash the process. Returns 400, not a 500/crash (Phase 4 finding — this used to crash the server).
- Classification and recovery never block or fail the webhook response — fire-and-forget after the 200 ack, logged separately, safe default on total provider failure.
- In-memory classification cache (10-min TTL, keyed by error_code+error_description hash) avoids re-classifying identical failures — logs `[classify] cache hit, skipped API call`.
- Session call ceilings (`MAX_LLM_CALLS_PER_SESSION`, `MAX_RAZORPAY_CALLS_PER_SESSION`) protect free-tier quota; `GET /api/debug/usage` exposes live counters. **`llmTotal()` in `usageCounters.js` must sum ALL provider names** — a rename once desynced this and silently stopped counting 2 of 3 providers toward the ceiling (found and fixed).
- Orphaned payments (process killed mid-classification, before the fire-and-forget completes) are healed via `POST /api/test/reclassify?minAgeSec=60` — a manual reconciliation sweep, not a scheduler (deliberately out of scope for buildathon timeline).
- Debug/test-only pages live under `/debug/*` routes, kept visually separate/utilitarian from the polished main dashboard.
- Before assuming a Groq/OpenRouter model name or JSON-mode config is valid, verify against the provider's live model list / docs — model availability and JSON-mode requirements vary by account and change without warning (hit real bugs from this twice: Groq model deprecation in Phase 2, and Groq JSON-mode/prompt requirements affecting `json_validate_failed` around the Nemotron switch).
- **Terminology precision for the pitch**: `classificationService.js` is the actual AI agent (LLM reasoning over unstructured input → structured decision). The orchestrator (`orchestratorService.js`) is a deterministic state machine / control-flow layer that sequences that decision via a fixed policy table (`escalationPolicy.js`) — it does not itself call an LLM. Don't overstate the orchestrator as "agentic" to judges; the honest framing (reasoning happens once at classification, orchestration just prevents that decision from dead-ending) is itself a good answer to "where's the AI judgment."
- **Known sandbox limitation**: this Razorpay test account flags essentially all test card numbers as `international: true` → `error_reason: international_transaction_not_allowed`, blocking at `payment_initiation` before other failure modes (expired, insufficient funds, etc.) can trigger. Confirmed via raw payload inspection — not a bug in this codebase. Full reason-taxonomy coverage is validated via `classificationService.test.js` (synthetic inputs), not live Razorpay traffic. Mention this distinction in the demo if asked about data variety.

## Phase status

- [x] Phase 1 — DB connection, schema, webhook (signature verify, insert, dedupe), health check, debug tooling
- [x] Phase 2 — LLM classification wired into webhook → `failure_classifications`, verified end to end. Stale-process bug found/fixed (restart with `npm run dev`, not `npm start`).
- [x] Phase 3 — Recovery strategy execution (`auto_retry` mocked, `payment_link` real via Razorpay Payment Links API) + real dashboard UI. `payment_link.paid` handler gap found (creation existed, read-back never wired) and fixed with a two-hop match (`reference_id` → `payments.razorpay_payment_id` → `payments.id` → `recovery_attempts`). Verified: real payment paid → `Recovered` moves off ₹0.
- [x] Phase 4 — Failure injection testing, 5/5 scenarios run: duplicate storm (found+fixed a 500-instead-of-200 race), malformed payload (found+fixed a process crash), all-providers-down (safe default confirmed working, no fix needed), mid-classify kill (found orphans, built reconciliation sweep), rate-limit ceiling (confirmed working). Full log in `docs/failures.md`.
- [x] Provider chain updated — Nemotron (OpenRouter) added as primary, Groq `json_validate_failed` root-caused (was a `usageCounters.js` naming desync, not a real Groq bug) and fixed. Reason taxonomy expanded 6→10 values + `detail` field added.
- [x] **Orchestrator** — sequential recovery escalation (`auto_retry` fail → `payment_link` → timeout → `alt_method` → `lost`), built incrementally (see `phase-5.md`). Steps 1-5 done, 7/7 test suites green. Race between the `payment_link` timeout and `payment_link.paid` resolved via atomic compare-and-set (`UPDATE … WHERE status='pending'`). Full escalation chain is a demo-time verification (needs live DB rows + Razorpay).
- [ ] Phase 5 (remainder) — Swagger/OpenAPI docs, architecture diagram, ADRs, classification eval set, demo video, final repo cleanup

Full detail per phase: see `phase-1.md` through `phase-4.md`, `phase-5.md` (orchestrator).