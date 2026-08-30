# Phase 1 — DB connection & foundation

**Version:** 1.0.0
**Goal:** Get Supabase connected, schema in place, and a working webhook skeleton that can receive and store a Razorpay failed-payment event. No LLM logic yet — that's Phase 2.

## 1. Supabase setup

1. Create a project at supabase.com (free tier).
2. Grab `Project URL`, `anon public key`, and `service_role key` from Settings → API.
3. Add to `/backend/.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=xxxx
   ```
4. Add to `/frontend/.env`:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=xxxx
   ```

## 2. Schema (run in Supabase SQL editor)

```sql
create table payments (
  id uuid primary key default gen_random_uuid(),
  razorpay_payment_id text unique not null,
  razorpay_order_id text,
  amount numeric not null,
  currency text default 'INR',
  status text not null default 'failed', -- failed | recovering | recovered | lost
  error_code text,
  error_description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table failure_classifications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  failure_reason text not null, -- e.g. insufficient_funds, bank_decline, network_timeout, card_expired
  confidence numeric,
  raw_llm_response jsonb,
  classified_at timestamptz default now()
);

create table recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id) on delete cascade,
  strategy text not null, -- auto_retry | payment_link | alt_method
  status text not null default 'pending', -- pending | success | failed
  recovered_amount numeric,
  notes text,
  attempted_at timestamptz default now()
);

create index idx_payments_status on payments(status);
create index idx_recovery_payment_id on recovery_attempts(payment_id);
```

## 3. Backend packages

```bash
cd backend
npm install @supabase/supabase-js express dotenv razorpay
npm install -D typescript @types/express @types/node ts-node-dev
```

## 4. Files to create

**`/backend/src/config/supabase.ts`**
```ts
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);
```

**`/backend/src/types/payment.ts`**
```ts
export interface PaymentFailure {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  amount: number;
  currency: string;
  error_code?: string;
  error_description?: string;
}
```

**`/backend/src/routes/health.ts`**
```ts
import { Router } from 'express';
import { supabase } from '../config/supabase';

const router = Router();

router.get('/health', async (_req, res) => {
  const { error } = await supabase.from('payments').select('id').limit(1);
  if (error) return res.status(500).json({ db: 'error', message: error.message });
  res.json({ status: 'ok', db: 'connected' });
});

export default router;
```

**`/backend/src/routes/webhook.ts`** (skeleton — signature verification + store only, no classification yet)
```ts
import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config/supabase';

const router = Router();

router.post('/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (signature !== expectedSignature) {
    return res.status(400).json({ error: 'invalid signature' });
  }

  const event = req.body.event;
  if (event !== 'payment.failed') {
    return res.status(200).json({ ignored: true });
  }

  const payment = req.body.payload.payment.entity;

  const { error } = await supabase.from('payments').insert({
    razorpay_payment_id: payment.id,
    razorpay_order_id: payment.order_id,
    amount: payment.amount / 100,
    currency: payment.currency,
    error_code: payment.error_code,
    error_description: payment.error_description,
    status: 'failed',
  });

  if (error) {
    console.error('DB insert failed:', error.message);
    return res.status(500).json({ error: 'db insert failed' });
  }

  res.status(200).json({ received: true });
});

export default router;
```

**`/backend/src/server.ts`**
```ts
import express from 'express';
import dotenv from 'dotenv';
import healthRoute from './routes/health';
import webhookRoute from './routes/webhook';

dotenv.config();
const app = express();
app.use(express.json());

app.use('/', healthRoute);
app.use('/', webhookRoute);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

## 5. Frontend Supabase client

**`/frontend/src/lib/supabaseClient.ts`**
```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

## 6. Acceptance criteria (Phase 1 done when...)

- [ ] `GET /health` returns `{ status: 'ok', db: 'connected' }`
- [ ] Sending a test `payment.failed` webhook (via Razorpay test-mode or curl with a valid signature) inserts a row into `payments`
- [ ] Frontend can read from Supabase (basic `select * from payments` test in console)
- [ ] `npm run lint` passes on both frontend and backend
- [ ] `.env.example` committed, real `.env` gitignored

## Next: Phase 2

LLM classification service (`classificationService.ts`) — sends `error_code` + `error_description` to Groq, gets back a structured `{ reason, confidence, suggested_strategy }`, writes to `failure_classifications`.