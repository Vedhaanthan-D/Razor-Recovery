# CLAUDE.md

Project context for AI coding assistance. Read this before making changes.

## Project

**Recovery Agent** — AI-powered payment recovery system for Razorpay AI Buildathon (Track 3: AI Revenue Recovery).

An agent that listens to failed Razorpay payment webhooks, classifies the failure reason using an LLM, picks a recovery strategy, and tracks outcomes on a dashboard.

## Current version

**v1.0.0** — Phase 1: DB connection + schema + webhook skeleton.

## Tech stack

- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Node.js + Express + TypeScript
- Database: Supabase (Postgres)
- LLM: Groq API (primary) — Mistral API as fallback/swap
- Payments: Razorpay test-mode APIs + webhooks
- Lint/format: ESLint + Prettier

## Folder structure

```
/backend
  /src
    /config       -> supabase.ts, env.ts
    /routes       -> webhook.ts, health.ts
    /services     -> paymentService.ts, classificationService.ts, recoveryService.ts
    /types        -> payment.ts
    server.ts
  .env.example
/frontend
  /src
    /components
    /pages
    /lib          -> supabaseClient.ts
```

## Environment variables

See `.env.example` in both `/backend` and `/frontend`. Never commit `.env`.

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (backend only — never expose to frontend)
- `SUPABASE_ANON_KEY` (frontend)
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `GROQ_API_KEY`

## Conventions

- TypeScript everywhere, but keep types practical — no over-engineered generics.
- All DB access goes through `/backend/src/config/supabase.ts` (single client instance).
- All Razorpay webhook signatures must be verified before processing (see `routes/webhook.ts`).
- Commit messages: short, imperative (`add webhook route`, `fix retry timing`).
- Keep `npm run lint` passing before each commit.

## Phase status

- [x] Phase 1 — DB connection, schema, webhook skeleton, health check
- [ ] Phase 2 — LLM classification + recovery strategy logic
- [ ] Phase 3 — Dashboard UI + recovery funnel
- [ ] Phase 4 — Failure injection testing (duplicate webhooks, retry storms, timeouts)
- [ ] Phase 5 — Demo video + architecture doc + repo cleanup

Full detail for the current phase: see `docs/phase-1.md`.