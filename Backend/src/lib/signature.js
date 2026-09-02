const crypto = require("crypto");

/**
 * Verify a Razorpay webhook signature against the RAW request body.
 * Razorpay signs the raw bytes it sent — never re-stringify req.body (key order /
 * whitespace can differ and break the HMAC). Feed the buffer captured in server.js.
 *
 * `secret` may be a single secret OR an array of secrets. With two Razorpay accounts failing over
 * (see recoveryService.js) their webhooks hit this SAME endpoint, and each account signs with its own
 * webhook secret — so a match against ANY configured secret verifies. A plain string keeps the
 * original single-account behaviour unchanged.
 *
 * @param {Buffer|string} rawBody     raw request body
 * @param {string} signature          x-razorpay-signature header
 * @param {string|string[]} secret    one or more RAZORPAY_WEBHOOK_SECRET values
 * @returns {boolean}
 */
function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!signature || rawBody == null) return false;
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  const b = Buffer.from(signature, "utf8");

  for (const s of secrets) {
    const expected = crypto.createHmac("sha256", s).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    // timingSafeEqual throws on length mismatch, so guard length first.
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

module.exports = { verifyRazorpaySignature };
