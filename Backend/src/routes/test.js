const { Router } = require("express");
const Razorpay = require("razorpay");
const { supabase } = require("../config/supabase");
const { snapshot } = require("../services/usageCounters");
const { classifyAndStore } = require("./webhook");

const router = Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// POST /api/debug/create-order — throwaway helper for the browser test-checkout page.
// Creates a Razorpay test-mode order; key_secret stays server-side, key_id (public) is returned.
router.post("/create-order", async (req, res) => {
  const rupees = Number(req.body.amount);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    return res.status(400).json({ error: "amount must be a positive number (rupees)" });
  }

  try {
    const order = await razorpay.orders.create({
      amount: Math.round(rupees * 100), // Razorpay expects paise
      currency: "INR",
    });
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Razorpay order create failed:", err?.error?.description || err.message);
    res.status(502).json({ error: "razorpay order create failed" });
  }
});

// GET /api/debug/payments — debug dashboard read. Uses service_role (bypasses RLS) so the
// browser needs no anon SELECT policy. ponytail: debug-only, gate/remove before prod.
// Embeds the payment's classification (Phase 2) so the full pipeline shows in one table.
router.get("/payments", async (_req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select(
      "razorpay_payment_id,amount,currency,error_code,error_description,status,created_at," +
        "failure_classifications(failure_reason,confidence,suggested_strategy,provider_used)"
    )
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Flatten the embedded classification (0-or-1 per payment) onto each row for the flat debug table.
  const rows = data.map(({ failure_classifications, ...p }) => {
    const c = (failure_classifications && failure_classifications[0]) || {};
    return {
      ...p,
      failure_reason: c.failure_reason ?? null,
      confidence: c.confidence ?? null,
      suggested_strategy: c.suggested_strategy ?? null,
      provider_used: c.provider_used ?? null,
    };
  });
  res.json(rows);
});

// GET /api/debug/usage — in-memory API-usage counters (see usageCounters.js). At-a-glance quota
// check during testing without digging through logs; resets on restart. ponytail: debug-only.
router.get("/usage", (_req, res) => {
  res.json(snapshot());
});

// POST /api/debug/reclassify — reconciliation sweep for the known orphan gap (Phase 4 / Test 4).
// Classification is fire-and-forget after the webhook 200s, so a crash/restart in that window leaves
// a payments row with no failure_classifications row. This finds those orphans and re-runs the exact
// webhook classify+recover path on each. Manual debug trigger — the documented fix; NOT a cron job.
// ?minAgeSec=N (default 60) skips payments younger than N seconds so a legitimately in-flight
// classification isn't double-run.
// ponytail: manual endpoint, no scheduler. Add a cron only if orphans pile up in production.
router.post("/reclassify", async (req, res) => {
  const minAgeSec = Number(req.query.minAgeSec) || 60;
  const cutoff = new Date(Date.now() - minAgeSec * 1000).toISOString();

  const { data, error } = await supabase
    .from("payments")
    .select(
      "id,razorpay_payment_id,razorpay_order_id,amount,currency,error_code,error_description," +
        "failure_classifications(id)"
    )
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const orphans = data.filter((p) => !p.failure_classifications || p.failure_classifications.length === 0);
  const reclassified = [];
  for (const p of orphans) {
    // Rebuild the Razorpay-entity shape classifyAndStore/executeRecovery expect: id is the razorpay
    // payment id (rec_ reference + description), and amount is paise (payments stores rupees).
    const entity = {
      id: p.razorpay_payment_id,
      order_id: p.razorpay_order_id,
      amount: Math.round(Number(p.amount) * 100),
      currency: p.currency,
      error_code: p.error_code,
      error_description: p.error_description,
    };
    await classifyAndStore(p.id, entity); // p.id (uuid) is the FK the classification row hangs off
    reclassified.push(p.razorpay_payment_id);
  }
  console.log(`[reclassify] swept ${data.length} payments older than ${minAgeSec}s → healed ${orphans.length} orphan(s)`);
  res.json({ cutoff, orphans_found: orphans.length, reclassified });
});

module.exports = router;