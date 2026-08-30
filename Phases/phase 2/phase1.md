# Phase 1 — DB connection & webhook foundation

**Version:** 1.0.0
**Status:** ✅ Complete and verified

## What this phase covers

Get Supabase connected, schema in place, and a working webhook that receives, verifies, and stores a real Razorpay failed-payment event end to end. No LLM logic — that's Phase 2.

## Deviations from original plan (deliberate)

| Planned | Actual | Reason |
|---|---|---|
| TypeScript | **JavaScript / CommonJS** | Matches existing `server.js`, avoided TS toolchain setup mid-sprint |
| Port unspecified | **Port 3000, `/api` prefix** | Matches Vite dev proxy config on frontend |
| `types/`, `services/` folders in Phase 1 | **Skipped**, added `src/lib/` instead | Not needed yet — `services/` starts in Phase 2 with `classificationService.js`; `lib/` holds the testable signature-verification util |

## Schema (Supabase, Postgres, RLS enabled)

```sql
create table payments (
  id uuid primary key default gen_random_uuid(),
  razorpay_payment_id text unique not null,
  razorpay_order_id text,
  amount numeric not null,
  currency text default 'INR',
  status text not null default 'failed',
  error_code text,
  error_description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table failure_classifications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  failure_reason text not null,
  confidence numeric,
  raw_llm_response jsonb,
  classified_at timestamptz default now()
);

create table recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  strategy text not null,
  status text not null default 'pending',
  recovered_amount numeric,
  notes text,
  attempted_at timestamptz default now()
);

create index idx_payments_status on payments(status);
create index idx_recovery_payment_id on recovery_attempts(payment_id);
```

RLS enabled on all three tables. Read policy (`for select using (true)`) added for the anon key so the frontend can read; only the backend's service_role key can write.

## Workflow implemented (failed payment → stored)

1. Razorpay fires a `payment.failed` webhook → `POST /api/webhook/razorpay`.
2. `express.json({ verify })` stashes the raw bytes on `req.rawBody`.
3. `verifyRazorpaySignature(rawBody, header, RAZORPAY_WEBHOOK_SECRET)` — HMAC-SHA256 over the raw body, timing-safe compare. Bad/absent signature → 400, nothing stored.
4. Non-`payment.failed` events → 200 `{ ignored: true }`.
5. Valid failed payment → insert into `payments` (paise→rupees conversion, `status: 'failed'`). Razorpay re-delivery (unique `razorpay_payment_id`, Postgres error `23505`) → 200 `{ duplicate: true }` so Razorpay stops retrying.
6. `GET /api/health` → runs a `select` on `payments` → `{ status: 'ok', db: 'connected' }`.

## Debug tooling built (not part of the product — verification only)

- `/debug/payments` — read-only table view of the `payments` table via the frontend Supabase client (anon key), with manual refresh
- `/debug/checkout` — tiny Razorpay Checkout.js test page: creates a real test-mode order via a backend route, opens Razorpay's hosted checkout, lets you trigger real failures with test cards — no Postman/curl needed

## Verified end to end

- ✅ Signature self-check script passes
- ✅ `GET /api/health` → `db: "connected"`
- ✅ Bad/missing signature → 400, no row inserted
- ✅ Real Razorpay test-mode payment triggered via `/debug/checkout`, failed on purpose (domestic-card-only restriction, `BAD_REQUEST_ERROR`), webhook fired, row landed correctly in `payments`
- ✅ Duplicate delivery handling in place (not yet forced/tested with an actual re-delivery, but logic verified by code review)
- ✅ Killed a stale process squatting on port 3000 during setup

## Run it

```bash
cd Backend && npm run dev      # http://localhost:3000  (npm test = signature check)
cd frontend && npm run dev     # proxies /api → :3000
npx ngrok http 3000            # public URL for Razorpay webhook delivery
```

## Env vars used

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

## Next: Phase 2

Wire `classificationService.js` (already built + unit tested standalone) into the webhook handler — classify every stored failed payment and write the result to `failure_classifications`. See `phase-2.md`.