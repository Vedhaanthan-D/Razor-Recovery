-- Razor Recovery — Phase 1 schema
-- Run in Supabase SQL editor (or: psql "$DATABASE_URL" -f db/schema.sql)
-- Idempotent: safe to re-run.

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  razorpay_payment_id text unique not null,
  razorpay_order_id text,
  amount numeric not null,
  currency text default 'INR',
  method text, -- card | upi | netbanking | wallet | emi | ...  (from payment.entity.method)
  status text not null default 'failed', -- failed | recovering | recovered | lost
  error_code text,  
  error_description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Payment mode: store payment.entity.method (card | upi | netbanking | wallet | emi | ...) so a trace
-- can read "₹500 via card". Idempotent — re-run safe. Rows created before this migration stay null
-- (Razorpay doesn't re-deliver events, so historical mode can't be backfilled).
alter table payments add column if not exists method text;

create table if not exists failure_classifications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  failure_reason text not null, -- insufficient_funds | bank_decline | network_timeout | card_expired | invalid_details | other
  confidence numeric,
  suggested_strategy text, -- auto_retry | payment_link | alt_method   (Phase 2)
  provider_used text,      -- groq_key1 | groq_key2 | mistral | fallback_default   (Phase 2)
  raw_llm_response jsonb,
  classified_at timestamptz default now()
);

-- Phase 2: add classification-result columns to an already-created table (idempotent — re-run safe).
alter table failure_classifications add column if not exists suggested_strategy text;
alter table failure_classifications add column if not exists provider_used text;
alter table failure_classifications add column if not exists detail text; -- one-sentence plain-language cause
-- Phase 6 (verifier): true = the low-confidence primary was OVERRIDDEN by the second-opinion agent
-- (the outcome changed). false = primary stood (verifier skipped, agreed, or its call failed).
alter table failure_classifications add column if not exists verified boolean default false;
-- Phase 6 (strategy advisor): one-line justification for the strategy actually used, e.g.
-- "payment_link outperforms auto_retry 75% vs 37.5% for network_timeout, N=20". Usually "insufficient data".
alter table failure_classifications add column if not exists advisor_note text;

create table if not exists recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  strategy text not null, -- auto_retry | payment_link | alt_method
  status text not null default 'pending', -- pending | success | failed
  recovered_amount numeric,
  notes text,
  attempted_at timestamptz default now()
);

create index if not exists idx_payments_status on payments(status);
create index if not exists idx_recovery_payment_id on recovery_attempts(payment_id);
create index if not exists idx_payments_razorpay_payment_id on payments(razorpay_payment_id);
create index if not exists idx_payments_created_at on payments(created_at);
