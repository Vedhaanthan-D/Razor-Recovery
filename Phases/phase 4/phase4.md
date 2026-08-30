# Phase 4 — Failure injection testing

**Version:** 1.3.0 (target)
**Status:** 🔲 Not started
**Depends on:** Phase 3 complete (verified — `payment_link` and `auto_retry` both confirmed working end to end, dashboard funnel numbers provably real)

## Why this phase matters most for judging

The panel's rubric explicitly includes **"failure recovery — what broke, and what you did about it."** Phases 1-3 built the happy path. This phase is where you deliberately break things and fix them — this becomes the core of your 5-minute pitch video and panel interview answers. Don't skip it or treat it as optional polish.

You've already hit two real bugs organically during Phases 2-3 (stale process not reloading, missing `payment_link.paid` handler) — those are good material too. This phase adds deliberate, demonstrable ones.

## What to test

### 1. Duplicate webhook storm
Resend the exact same signed `payment.failed` event 5-10 times rapidly (script a loop, or replay from Razorpay's webhook delivery log if it has a "resend" option).
- **Expect:** exactly one `payments` row, one `failure_classifications` row, one `recovery_attempts` row. Every duplicate after the first returns `{ duplicate: true }` and does nothing further.
- **If it fails:** race condition — two near-simultaneous inserts both pass the "does this exist" check before either commits. Fix: rely on the DB unique constraint + catching Postgres error `23505`, not a pre-check-then-insert pattern.

### 2. Malformed / garbage payload with a valid signature
Send a payload that's valid JSON but missing expected fields (e.g. `payload.payment.entity` is `null`, or `event` field is missing entirely) — but signed correctly with your real secret so it passes verification.
- **Expect:** graceful rejection (400 or logged skip), not a server crash or unhandled exception.
- **If it crashes:** add defensive checks before accessing nested payload fields.

### 3. All LLM providers down at once
Temporarily set all three keys (`GROQ_API_KEY`, `GROQ_API_KEY_2`, `MISTRAL_API_KEY`) to garbage values in `.env`, restart, trigger a real failed payment.
- **Expect:** payment still stores fine, classification falls through all three, lands on the safe default (`reason: 'other', confidence: 0, suggested_strategy: 'payment_link'`), recovery still attempts based on that default. Webhook still returns 200 to Razorpay throughout.
- **If it fails:** something in the fallback chain throws instead of resolving to the default — check `classifyFailure`'s outer catch.
- Restore real keys after this test.

### 4. Process killed mid-classification
Trigger a failed payment, then kill the backend process (Ctrl+C or `kill`) in the ~1-2 second window between the webhook's 200 response and classification completing (timing this precisely is hard — approximate it, or add a temporary artificial delay to widen the window for testing purposes only, then remove it).
- **Expect to find:** a `payments` row with no matching `failure_classifications` row — an orphan.
- **This is a known, accepted gap** (already flagged in phase-2.md) — Phase 4 doesn't need to fully solve it, but you should **know it exists, demonstrate you found it, and describe the fix** (a reconciliation sweep — a scheduled job or manual endpoint that finds `payments` rows older than N minutes with no classification and reclassifies them). Building the actual sweep is optional bonus points if time allows; the `/api/test/reclassify` endpoint idea from Phase 2 covers this.

### 5. Rate limit / quota exhaustion simulation
If you built the session call-counter safeguards (from the earlier API-usage-hygiene prompt), lower `MAX_LLM_CALLS_PER_SESSION` to something tiny (e.g. `2`) temporarily, trigger 3+ failed payments in a row.
- **Expect:** first two classify normally, third+ immediately returns the safe default with a logged warning, no API call attempted.
- Restore the real limit after testing.

## What NOT to do in this phase

- Don't try to "fix" every edge case exhaustively — you have limited time. Pick 3-4 of the above, actually run them, document what happened.
- Don't over-engineer solutions (e.g. don't build a full job queue for the reconciliation sweep — a simple debug endpoint is enough to demonstrate the concept).

## Deliverable for this phase

A short written log (can live in this file or a separate `docs/failures.md`) with one entry per test:
```
## Test: [name]
What I did: ...
Expected: ...
Actual: ...
Fix (if needed): ...
```
This is your source material for the demo video narration and panel Q&A — write it as you go, not retroactively.

## Acceptance criteria

- [ ] At least 3 of the 5 scenarios above actually run (not just read/assumed) and outcome documented
- [ ] Any genuine bug found is either fixed, or explicitly documented as a known limitation with a described (even if unbuilt) fix
- [ ] Failure log written and ready to reference for the demo video

## Next: Phase 5

Demo video (5 min), architecture doc/diagram, repo cleanup (remove debug `console.log` dumps, confirm `.env` is gitignored, tidy README pointing to CLAUDE.md + phase docs).