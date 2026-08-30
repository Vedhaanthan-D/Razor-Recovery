// Run: node src/agents/verifierService.test.js   (or: npm run test:verifier)
// Pure/deterministic — no real API calls. The LLM second opinion is injected via deps.secondOpinion.
const assert = require("assert");
const { verifyClassification, pickVerifierProvider } = require("./verifierService");
const { llmTotal } = require("../services/usageCounters");

// A stubbed second opinion that records how many times it ran.
function spy(impl) {
  const fn = async (...args) => {
    fn.calls++;
    return impl(...args);
  };
  fn.calls = 0;
  return fn;
}

const payment = { error_code: "BAD_REQUEST_ERROR", error_description: "issuer declined the transaction" };

(async () => {
  // 1. High-confidence primary → verifier SKIPPED, no API call at all.
  {
    const primary = { reason: "insufficient_funds", detail: "Balance too low.", confidence: 0.8, suggested_strategy: "payment_link", provider_used: "openrouter" };
    const before = llmTotal();
    const secondOpinion = spy(async () => { throw new Error("should never be called"); });
    const out = await verifyClassification(payment, primary, { secondOpinion });
    assert.strictEqual(secondOpinion.calls, 0, "confidence >= 0.5 makes no verifier call");
    assert.strictEqual(llmTotal(), before, "skip path spends no LLM quota");
    assert.strictEqual(out.reason, "insufficient_funds", "primary reason unchanged");
    assert.strictEqual(out.confidence, 0.8, "primary confidence unchanged");
    assert.strictEqual(out.verified, false, "skip → verified false");
  }

  // 2. Low-confidence primary + verifier AGREES → confidence boosted (+0.2, capped 1), primary stands.
  {
    const primary = { reason: "insufficient_funds", detail: "Balance too low.", confidence: 0.3, suggested_strategy: "payment_link", provider_used: "openrouter" };
    const secondOpinion = spy(async () => ({ reason: "insufficient_funds", detail: "Not enough funds.", confidence: 0.7, suggested_strategy: "payment_link", provider_used: "groq" }));
    const out = await verifyClassification(payment, primary, { secondOpinion });
    assert.strictEqual(secondOpinion.calls, 1, "low confidence triggers one verifier call");
    assert.strictEqual(out.reason, "insufficient_funds", "agree keeps primary reason");
    assert.strictEqual(out.confidence, 0.5, "confidence boosted 0.3 -> 0.5");
    assert.strictEqual(out.provider_used, "openrouter", "agree keeps primary provider");
    assert.strictEqual(out.verified, false, "agree is not an override → verified false");
  }

  // 2b. Boost is capped at 1.0.
  {
    const primary = { reason: "bank_decline", detail: "Bank declined.", confidence: 0.45, suggested_strategy: "auto_retry", provider_used: "groq" };
    const secondOpinion = spy(async () => ({ reason: "bank_decline", detail: "Issuer refused.", confidence: 0.9, suggested_strategy: "auto_retry", provider_used: "mistral" }));
    const out = await verifyClassification(payment, primary, { secondOpinion });
    assert.ok(out.confidence <= 1, "boosted confidence never exceeds 1");
    assert.strictEqual(out.confidence, 0.65, "0.45 + 0.2 = 0.65");
  }

  // 3. Low-confidence primary + verifier DISAGREES → verifier's result wins (tie-breaker), verified true.
  {
    const primary = { reason: "bank_decline", detail: "Bank declined.", confidence: 0.2, suggested_strategy: "auto_retry", provider_used: "openrouter" };
    const secondOpinion = spy(async () => ({ reason: "insufficient_funds", detail: "Account underfunded.", confidence: 0.85, suggested_strategy: "payment_link", provider_used: "groq" }));
    const out = await verifyClassification(payment, primary, { secondOpinion });
    assert.strictEqual(secondOpinion.calls, 1, "disagree still one call");
    assert.strictEqual(out.reason, "insufficient_funds", "override returns the VERIFIER reason");
    assert.strictEqual(out.suggested_strategy, "payment_link", "override returns the verifier strategy");
    assert.strictEqual(out.confidence, 0.85, "override carries the verifier confidence");
    assert.strictEqual(out.provider_used, "groq", "override records the verifier provider");
    assert.strictEqual(out.verified, true, "override → verified true (outcome changed)");
  }

  // 4. Verifier call FAILS → fall back to the primary, safely, no throw.
  {
    const primary = { reason: "network_timeout", detail: "Gateway timed out.", confidence: 0.1, suggested_strategy: "auto_retry", provider_used: "openrouter" };
    const secondOpinion = spy(async () => { throw new Error("provider 500"); });
    const out = await verifyClassification(payment, primary, { secondOpinion });
    assert.strictEqual(secondOpinion.calls, 1, "it did attempt the verifier call");
    assert.strictEqual(out.reason, "network_timeout", "failure keeps primary reason");
    assert.strictEqual(out.confidence, 0.1, "failure keeps primary confidence (no boost)");
    assert.strictEqual(out.verified, false, "failure → verified false");
  }

  // Provider selection: the verifier must call a DIFFERENT provider than the primary used.
  // Set dummy keys so the pick is deterministic regardless of .env.
  {
    process.env.OPENROUTER_API_KEY = "test";
    process.env.GROQ_API_KEY = "test";
    process.env.MISTRAL_API_KEY = "test";
    assert.strictEqual(pickVerifierProvider("openrouter"), "groq", "openrouter primary → groq verifier");
    assert.strictEqual(pickVerifierProvider("groq"), "mistral", "groq primary → mistral verifier");
    assert.strictEqual(pickVerifierProvider("mistral"), "openrouter", "mistral primary → openrouter verifier");
    for (const p of ["openrouter", "groq", "mistral"]) {
      assert.notStrictEqual(pickVerifierProvider(p), p, `verifier is never the same provider as primary (${p})`);
    }
    // No key for the preferred alternate → falls through to another provider that has one.
    delete process.env.GROQ_API_KEY;
    assert.strictEqual(pickVerifierProvider("openrouter"), "mistral", "openrouter primary, no groq key → mistral");
    // No alternate has a key → null (caller keeps primary).
    delete process.env.MISTRAL_API_KEY;
    assert.strictEqual(pickVerifierProvider("openrouter"), null, "no alternate with a key → null");
  }

  console.log("verifierService.test.js: all assertions passed");
})().catch((e) => {
  console.error("self-test crashed (verifyClassification should never throw):", e);
  process.exit(1);
});
