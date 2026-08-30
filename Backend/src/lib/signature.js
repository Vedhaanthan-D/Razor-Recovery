const crypto = require("crypto");

/**
 * Verify a Razorpay webhook signature against the RAW request body.
 * Razorpay signs the raw bytes it sent — never re-stringify req.body (key order /
 * whitespace can differ and break the HMAC). Feed the buffer captured in server.js.
 *
 * @param {Buffer|string} rawBody  raw request body
 * @param {string} signature       x-razorpay-signature header
 * @param {string} secret          RAZORPAY_WEBHOOK_SECRET
 * @returns {boolean}
 */
function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!signature || !secret || rawBody == null) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");

  // timingSafeEqual throws on length mismatch, so guard length first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyRazorpaySignature };
