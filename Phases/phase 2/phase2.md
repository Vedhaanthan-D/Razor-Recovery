# Phase 2 — LLM classification

**Version:** 1.1.0 (target)
**Status:** 🟡 Code complete — `classificationService.js` wired into `webhook.js`, dashboard extended, schema migrated. Pending live verification (acceptance criteria below) + the `GROQ_MODEL` fix in `.env`.

## Goal

Every time a failed payment lands in `payments`, immediately classify *why* it failed and *what recovery strategy fits*, then store that result in `failure_classifications`.

## What's already done (from earlier)

- `Backend/src/services/classificationService.js` exists
- 3-way fallback chain: Groq key1 → Groq key2 → Mistral
- Models read from env: `GROQ_MODEL`, `GROQ_MODEL_2`, `MISTRAL_MODEL`
- Returns `{ reason, confidence, suggested_strategy, provider_used }`
- 5s timeout per provider, safe default on total failure, never throws
- Standalone self-test script passes — confirmed Mistral (`ministral-8b-2512`) returns valid classification; Groq legs currently 404ing on `llama-3.1-8b-instant` (deprecated on your account) — pending model fix in `.env` (`GROQ_MODEL=openai/gpt-oss-20b` or whatever `curl /v1/models` confirms is available)

## What Phase 2 adds

### 1. Wire into the webhook handler

After the successful `payments` insert in `webhook.js`, call `classifyFailure()` with the payment's `error_code` and `error_description`, then insert the result into `failure_classifications` linked by `payment_id`.

Key decisions to bake in:
- Classification failure must **never** fail the webhook response — Razorpay should still get a 200 for the payment insert even if classification fails. Log the classification error separately.
- Run classification **after** responding to Razorpay if possible (or at minimum, don't let a slow LLM call delay Razorpay's webhook timeout — Razorpay expects a fast response, typically under a few seconds).
- Duplicate webhook deliveries (`{ duplicate: true }` path) should **not** re-trigger classification — only classify on first insert.

### 2. Extend the debug dashboard

Update `/debug/payments` (or add a joined view) to also show, per payment row: `failure_reason`, `confidence`, `suggested_strategy`, `provider_used` — so you can visually confirm the full pipeline: webhook → stored → classified, in one place.

### 3. Acceptance criteria

- [ ] `GROQ_MODEL`/`GROQ_MODEL_2` set to a model your keys can actually access (verify via `curl .../v1/models`), Groq legs passing in self-test again
- [ ] Triggering a real failed payment via `/debug/checkout` results in a row in `payments` **and** a matching row in `failure_classifications` within a few seconds
- [ ] Classification failure (simulate by temporarily breaking all 3 API keys) does not break the webhook — payment still stores, response still 200, error just logged
- [ ] Duplicate webhook delivery does not create a duplicate classification row
- [ ] `/debug/payments` shows classification result alongside payment data

## Next: Phase 3

Recovery strategy execution (`recovery_attempts`) — act on `suggested_strategy` (auto-retry, payment link, alt method), then the real dashboard UI with the recovery funnel.