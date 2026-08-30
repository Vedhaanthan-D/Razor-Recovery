// Phase 4 failure-injection harness. Sends CORRECTLY-SIGNED webhooks to the running server so you
// can reproduce duplicate storms, malformed payloads, provider outages, and quota exhaustion on
// demand. Hits localhost directly (no ngrok needed) for deterministic, repeatable tests.
//
// Run from Backend/ (so .env loads):  node scripts/inject.js <command> [flags]
// Requires Node 18+ (global fetch).
require("dotenv").config();
const crypto = require("crypto");
const { verifyRazorpaySignature } = require("../src/lib/signature");

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const URL = flag("url", `http://localhost:${process.env.PORT || 3000}/api/webhook/razorpay`);
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

function failedPayload(id, code, desc, method) {
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id,
          order_id: `order_${id}`,
          amount: 50000, // paise → ₹500
          currency: "INR",
          method, // card | upi | netbanking | wallet | emi | ... (mirrors Razorpay's payment.entity.method)
          error_code: code,
          error_description: desc,
        },
      },
    },
  };
}

// Valid JSON, correctly signed, but structurally broken — Test 2. no-entity/null-entity currently
// throw in webhook.js (the bug); no-event should be handled gracefully (returns ignored:true).
const MALFORMED = {
  "no-entity": { event: "payment.failed", payload: {} },
  "null-entity": { event: "payment.failed", payload: { payment: { entity: null } } },
  "no-event": { payload: { payment: { entity: { id: "pay_noevent" } } } },
};

// Sign the EXACT bytes we send — Razorpay signs the raw body, so never re-stringify after signing.
async function send(payload) {
  if (!SECRET) {
    console.error("RAZORPAY_WEBHOOK_SECRET not set — run from Backend/ with a real .env");
    process.exit(1);
  }
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");

  // Self-check the footgun: our signature must satisfy the server's own verifier over these bytes.
  if (!verifyRazorpaySignature(Buffer.from(body), sig, SECRET)) {
    throw new Error("self-check failed: signature does not verify locally — aborting send");
  }
  if (has("dry-run")) {
    console.log("DRY RUN\n  body:", body, "\n  x-razorpay-signature:", sig);
    return;
  }
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig },
    body,
  });
  console.log(`  → ${res.status} ${await res.text()}`);
}

(async () => {
  if (cmd === "failed") {
    const count = Number(flag("count", "1"));
    // Fixed --id → duplicate storm (test 1). Default unique id → a fresh failed payment (tests 3 & 5).
    const id = flag("id", `pay_inj_${Date.now()}`);
    const code = flag("code", "BAD_REQUEST_ERROR");
    const desc = flag("desc", "payment failed (injected)");
    const method = flag("method", "card"); // card | upi | netbanking | wallet | emi | ...
    console.log(`sending ${count} payment.failed event(s), id=${id}`);
    // Fire concurrently so a duplicate storm actually races the DB insert (proves 23505 dedup, not
    // a pre-check). Single events (count=1) behave identically.
    await Promise.all(Array.from({ length: count }, () => send(failedPayload(id, code, desc, method))));
  } else if (cmd === "malformed") {
    const kase = flag("case", "no-entity");
    const payload = MALFORMED[kase];
    if (!payload) {
      console.error(`unknown --case ${kase}; options: ${Object.keys(MALFORMED).join(", ")}`);
      process.exit(1);
    }
    console.log(`sending malformed payload, case=${kase}`);
    await send(payload);
  } else {
    console.log(
      [
        "Phase 4 failure-injection harness. Run from Backend/ (Node 18+).",
        "",
        "  node scripts/inject.js failed [--count N] [--id pay_x] [--code C] [--desc D] [--method M] [--dry-run]",
        "      Send N signed payment.failed events (fired concurrently).",
        "      Fixed --id  => duplicate storm            (Test 1)",
        "      Default id  => a fresh failed payment      (Tests 3 & 5 trigger)",
        "      --method    => payment mode (card|upi|netbanking|wallet|emi|...), default card",
        "",
        "  node scripts/inject.js malformed [--case no-entity|null-entity|no-event] [--dry-run]",
        "      Send a valid-JSON, correctly-signed but broken payload   (Test 2)",
        "",
        "  --url overrides the target (default http://localhost:PORT/api/webhook/razorpay)",
        "  --dry-run prints the signed body without sending",
      ].join("\n")
    );
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
