// Run: node src/lib/signature.test.js   (no framework — plain assert)
const assert = require("assert");
const crypto = require("crypto");
const { verifyRazorpaySignature } = require("./signature");

const secret = "whsec_test";
const body = JSON.stringify({ event: "payment.failed", payload: {} });
const good = crypto.createHmac("sha256", secret).update(body).digest("hex");

assert.strictEqual(verifyRazorpaySignature(body, good, secret), true, "valid signature should pass");
assert.strictEqual(verifyRazorpaySignature(body, good, "wrong-secret"), false, "wrong secret should fail");
assert.strictEqual(verifyRazorpaySignature(body, "deadbeef", secret), false, "tampered signature should fail");
assert.strictEqual(verifyRazorpaySignature(body + "x", good, secret), false, "tampered body should fail");
assert.strictEqual(verifyRazorpaySignature(body, "", secret), false, "empty signature should fail");
assert.strictEqual(verifyRazorpaySignature(null, good, secret), false, "missing body should fail");

// Multi-secret (two-account failover): a match against ANY configured secret passes; none → fail.
assert.strictEqual(verifyRazorpaySignature(body, good, ["wrong-1", secret]), true, "array: matches second secret");
assert.strictEqual(verifyRazorpaySignature(body, good, [secret, "wrong-2"]), true, "array: matches first secret");
assert.strictEqual(verifyRazorpaySignature(body, good, ["wrong-1", "wrong-2"]), false, "array: no secret matches → fail");
assert.strictEqual(verifyRazorpaySignature(body, good, []), false, "array: empty → fail");

console.log("signature.test.js: all assertions passed");
