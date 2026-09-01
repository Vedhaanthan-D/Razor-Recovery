// Temporary end-to-end verification harness for the "only real recoveries" change.
// Fires correctly-signed webhooks at a RUNNING server, drives exactly one real payment_link.paid,
// polls GET /api/dashboard, and asserts that auto_retry / alt_method NEVER show success — the only
// success is an actually-paid payment link. Covers card / netbanking / upi / wallet across the
// bank_decline, network_timeout, insufficient_funds, card_expired and currency_mismatch reasons.
//
//   node scripts/e2e-check.js           # run the checks (needs the server up)
//   node scripts/e2e-check.js cleanup   # delete the pay_e2e_* rows this harness created
//
// Run the server with fast demo timers so the whole escalation chain completes in seconds:
//   AUTO_RETRY_RESOLVE_MS=1500 PAYMENT_LINK_TIMEOUT_MINUTES=0.3 node src/server.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_URL = `${BASE}/api/webhook/razorpay`;
const DASH_URL = `${BASE}/api/dashboard`;
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const AMT = 50000; // paise → ₹500 for every scenario (keeps the recovered-amount check simple)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (body) => crypto.createHmac("sha256", SECRET).update(body).digest("hex");

async function postWebhook(payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sign(body) },
    body,
  });
  return { status: res.status, text: (await res.text()).slice(0, 120) };
}
const failedPayload = (id, code, desc, method) => ({
  event: "payment.failed",
  payload: { payment: { entity: { id, order_id: `order_${id}`, amount: AMT, currency: "INR", method, error_code: code, error_description: desc } } },
});
const paidPayload = (rpid) => ({
  event: "payment_link.paid",
  payload: { payment_link: { entity: { reference_id: `rec_${rpid}`, amount: AMT } }, payment: { entity: { amount: AMT } } },
});
async function getDashboard() {
  const res = await fetch(DASH_URL);
  if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
  return res.json();
}
async function waitForServer(ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server not reachable at ${BASE} — start it first`);
}

async function cleanup() {
  const { supabase } = require("../src/config/supabase");
  const { data, error } = await supabase.from("payments").delete().like("razorpay_payment_id", "pay_e2e_%").select("razorpay_payment_id");
  if (error) { console.error("cleanup failed:", error.message); process.exit(1); }
  console.log(`cleanup: deleted ${data ? data.length : 0} pay_e2e_* payment row(s) (classifications + attempts cascade).`);
}

async function main() {
  if (process.argv[2] === "cleanup") return cleanup();
  if (!SECRET) { console.error("RAZORPAY_WEBHOOK_SECRET missing — run with Backend/.env present"); process.exit(1); }

  await waitForServer();
  const run = Date.now();
  // pay:true → we send a real payment_link.paid for this one (the ONLY legitimate success path).
  const scenarios = [
    { label: "netbanking/bank_decline",  method: "netbanking", code: "BAD_REQUEST_ERROR", desc: "the bank declined the transaction", pay: false },
    { label: "upi/network_timeout",      method: "upi",        code: "GATEWAY_ERROR",     desc: "the request to the bank timed out with no response", pay: false },
    { label: "card/insufficient_funds",  method: "card",       code: "BAD_REQUEST_ERROR", desc: "the card has insufficient funds for this payment", pay: true },
    { label: "card/card_expired",        method: "card",       code: "BAD_REQUEST_ERROR", desc: "the card used for the payment has expired", pay: false },
    { label: "wallet/currency_mismatch", method: "wallet",     code: "BAD_REQUEST_ERROR", desc: "the payment currency does not match the account currency", pay: false },
  ].map((s, i) => ({ ...s, id: `pay_e2e_${run}_${i}` }));

  console.log(`\n=== injecting ${scenarios.length} failed payments (run ${run}) ===`);
  for (const s of scenarios) {
    const r = await postWebhook(failedPayload(s.id, s.code, s.desc, s.method));
    console.log(`  ${s.label.padEnd(24)} ${s.id}  → ${r.status} ${r.text}`);
  }

  const byId = (recent, id) => (recent || []).find((x) => x.razorpay_payment_id === id);
  const paid = new Set();
  const MAX_MS = 100000, POLL = 2500, start = Date.now();
  let last = null;

  while (Date.now() - start < MAX_MS) {
    await sleep(POLL);
    let dash;
    try { dash = await getDashboard(); } catch (e) { console.log(`  (dashboard: ${e.message})`); continue; }
    last = dash;
    const recent = dash.recent || [];

    for (const s of scenarios) {
      if (!s.pay || paid.has(s.id)) continue;
      const p = byId(recent, s.id);
      const link = p && (p.attempts || []).find((a) => a.strategy === "payment_link" && a.status === "pending");
      if (link) {
        const r = await postWebhook(paidPayload(s.id));
        console.log(`  >> paid the payment link for ${s.label} → ${r.status} ${r.text}`);
        paid.add(s.id);
      }
    }

    const state = (s) => {
      const p = byId(recent, s.id);
      if (!p) return "absent";
      const at = p.attempts || [];
      if (at.some((a) => a.status === "success")) return "recovered";
      if (p.status === "lost") return "lost";
      if (!at.length) return "classifying";
      return at.some((a) => a.status === "pending") ? "in-progress" : "settling";
    };
    console.log(`  [t+${String(Math.round((Date.now() - start) / 1000)).padStart(2)}s] ` + scenarios.map((s) => `${s.method}=${state(s)}`).join("  "));

    const payDone = scenarios.filter((s) => s.pay).every((s) => state(s) === "recovered");
    const restDone = scenarios.filter((s) => !s.pay).every((s) => state(s) === "lost");
    if (payDone && restDone) break;
  }

  const recent = (last || await getDashboard()).recent || [];
  console.log(`\n=== final outcomes ===`);
  const rows = scenarios.map((s) => ({ s, p: byId(recent, s.id) }));
  for (const { s, p } of rows) {
    if (!p) { console.log(`  ${s.label}: ABSENT`); continue; }
    const chain = (p.attempts || []).map((a) => `${a.strategy}:${a.status}`).join(" → ") || "(none)";
    console.log(`  ${s.label.padEnd(24)} reason=${String(p.failure_reason).padEnd(20)} pay.status=${String(p.status).padEnd(8)} recovery=${String(p.recovery_status).padEnd(8)} ₹${p.recovered_amount ?? "-"}`);
    console.log(`      chain: ${chain}`);
  }

  console.log(`\n=== assertions ===`);
  let fails = 0;
  const check = (ok, msg) => { console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`); if (!ok) fails++; };

  const fabricated = [];
  for (const { s, p } of rows) for (const a of (p && p.attempts) || [])
    if ((a.strategy === "auto_retry" || a.strategy === "alt_method") && a.status === "success") fabricated.push(`${s.label}:${a.strategy}`);
  check(fabricated.length === 0, `no auto_retry/alt_method attempt is ever "success" (fabricated: ${fabricated.join(", ") || "none"})`);

  const payRow = rows.find((r) => r.s.pay);
  const paySuccess = payRow && payRow.p && (payRow.p.attempts || []).find((a) => a.status === "success");
  check(!!paySuccess && paySuccess.strategy === "payment_link" && Number(payRow.p.recovered_amount) > 0,
    `the paid payment link → success with a real recovered amount (₹${payRow && payRow.p ? payRow.p.recovered_amount : "n/a"})`);

  const expired = rows.find((r) => r.s.label.includes("card_expired"));
  if (expired && expired.p) check(!(expired.p.attempts || []).some((a) => a.strategy === "auto_retry"), `card_expired never attempted auto_retry (ban invariant)`);

  check(rows.filter((r) => !r.s.pay).every((r) => r.p && r.p.recovery_status !== "success"),
    `every unpaid failed payment ended WITHOUT a success (no money claimed)`);

  console.log(`\n=== ${fails === 0 ? "ALL CHECKS PASSED ✅" : fails + " CHECK(S) FAILED ❌"} ===`);
  console.log(`(rows tagged pay_e2e_${run}_*  —  'node scripts/e2e-check.js cleanup' removes them)`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e-check crashed:", e && e.message ? e.message : e); process.exit(1); });
