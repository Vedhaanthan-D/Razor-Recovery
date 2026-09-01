// Run: node src/agents/insightsService.test.js   (or: npm run test:insights)
// No DB, no LLM: loadAggregate + callLLM are injected via deps. Exercises the real prompt-building,
// cache, and fallback paths.
const assert = require("assert");
const { generateInsight, answerQuestion, templateSummary, buildUserPrompt, buildAskPrompt, _clearCache } = require("./insightsService");

// A realistic aggregate (same shape dashboard.js's aggregate() returns).
function fixture() {
  return {
    funnel: { failed: 10, classified: 10, recovery_attempted: 8, recovered: 5 },
    money: { recovered: 12400, lost: 8000, currency: "INR" },
    by_reason: [
      { reason: "network_timeout", count: 6 },
      { reason: "insufficient_funds", count: 4 },
    ],
    by_strategy: [
      { strategy: "payment_link", attempted: 12, succeeded: 9, success_rate: 0.75 },
      { strategy: "auto_retry", attempted: 8, succeeded: 3, success_rate: 0.375 },
    ],
    recent: [
      {
        razorpay_payment_id: "pay_TEST123",
        amount: 5000,
        currency: "INR",
        status: "lost",
        failure_reason: "network_timeout",
        detail: "gateway timeout",
        confidence: 0.9,
        suggested_strategy: "auto_retry",
        provider_used: "groq",
        verified: false,
        advisor_note: null,
        recovery_strategy: "auto_retry",
        recovery_status: "failed",
        recovered_amount: null,
        recovery_notes: null,
        attempts: [{ strategy: "auto_retry", status: "failed", recovered_amount: null, notes: null, attempted_at: "2026-08-28T10:00:00Z" }],
      },
    ],
  };
}

(async () => {
  // 1. Successful generation — the LLM prompt carries the REAL aggregate numbers, and the returned
  //    summary is the model's text (whitespace-collapsed).
  {
    _clearCache();
    let seenUser = "";
    const callLLM = async (_system, user) => {
      seenUser = user;
      return "  Recovered ₹12,400 of ₹20,400 (61%).\n  network_timeout is the top failure; payment_link is outperforming auto_retry.  ";
    };
    const out = await generateInsight({ loadAggregate: async () => fixture(), callLLM });

    // real numbers reached the model, not placeholders
    assert.ok(seenUser.includes("12400"), "user prompt includes recovered amount");
    assert.ok(seenUser.includes("8000"), "user prompt includes lost amount");
    assert.ok(seenUser.includes("network_timeout"), "user prompt includes the top failure reason");
    assert.ok(seenUser.includes("payment_link"), "user prompt includes strategy stats");

    assert.ok(!/\s{2,}|\n/.test(out.summary), "summary is whitespace-collapsed");
    assert.ok(out.summary.startsWith("Recovered ₹12,400"), "summary is the model's text");
    assert.ok(out.generated_at, "generated_at is set");
  }

  // 2. LLM failure → templated fallback built from the raw numbers (never throws).
  {
    _clearCache();
    const agg = fixture();
    const boom = async () => { throw new Error("all providers down"); };
    const out = await generateInsight({ loadAggregate: async () => agg, callLLM: boom });

    assert.strictEqual(out.summary, templateSummary(agg), "fallback is the template");
    assert.match(out.summary, /50%/, "fallback has the real recovery rate");        // 5/10 (count-based)
    assert.match(out.summary, /network_timeout/, "fallback names the top failure");
    assert.match(out.summary, /12,400/, "fallback shows the recovered amount");
    assert.ok(out.generated_at, "generated_at still set on fallback");
  }

  // 3. Cache: within the TTL, a second call returns the cached value without re-loading or re-calling the LLM.
  {
    _clearCache();
    let loads = 0, calls = 0;
    const deps = {
      loadAggregate: async () => { loads++; return fixture(); },
      callLLM: async () => { calls++; return "cached summary text"; },
    };
    const first = await generateInsight(deps);
    const second = await generateInsight(deps);

    assert.strictEqual(loads, 1, "aggregate loaded once (second call is a cache hit)");
    assert.strictEqual(calls, 1, "LLM called once (second call is a cache hit)");
    assert.deepStrictEqual(second, first, "cache returns the identical value");

    _clearCache();
    await generateInsight(deps);
    assert.strictEqual(calls, 2, "after cache clear, the LLM is called again (cache miss)");
  }

  // 4. buildUserPrompt embeds computed fields, not just echoes.
  {
    const p = buildUserPrompt(fixture());
    assert.ok(p.includes("\"recovery_rate_pct\":50"), "prompt includes the computed recovery rate");
    assert.ok(p.includes("\"success_rate_pct\":75"), "prompt includes per-strategy success rate");
    assert.ok(!p.includes("recent"), "prompt drops the noisy recent[] table");
  }

  // ── answerQuestion (Ask the dashboard) ──

  // 5. A valid question reaches the LLM carrying the REAL aggregate AND the recent trace data, and
  //    the returned answer is the model's text (whitespace-collapsed). Confirms the prompt is grounded.
  {
    let calls = 0, seenSystem = "", seenUser = "";
    const callLLM = async (system, user) => {
      calls++; seenSystem = system; seenUser = user;
      return "  network_timeout is the most common failure, with 6 occurrences.  ";
    };
    const out = await answerQuestion("Which failure reason is most common?", { loadAggregate: async () => fixture(), callLLM });

    assert.strictEqual(calls, 1, "the provider was called exactly once");
    assert.ok(out.ok, "result is ok");
    assert.strictEqual(out.status, 200, "success maps to 200");
    assert.strictEqual(out.answer, "network_timeout is the most common failure, with 6 occurrences.", "answer is the model's text, whitespace-collapsed");

    // Real aggregate numbers reached the model — not placeholders.
    assert.ok(seenUser.includes("12400"), "prompt carries the recovered amount");
    assert.ok(seenUser.includes("8000"), "prompt carries the lost amount");
    assert.ok(seenUser.includes("network_timeout"), "prompt carries the top failure reason");
    assert.ok(seenUser.includes("payment_link"), "prompt carries per-strategy stats");
    // Recent per-payment trace data rode along too (not only the aggregate).
    assert.ok(seenUser.includes("pay_TEST123"), "prompt carries recent per-payment traces");
    // The user's question and the in-scope-only guardrail are both present.
    assert.ok(seenUser.includes("Which failure reason is most common?"), "prompt carries the user's question");
    assert.match(seenSystem, /ONLY using the data/i, "system prompt bounds the model to the provided data");
  }

  // 6. Empty / whitespace-only questions are rejected BEFORE any provider call (no wasted API call).
  {
    let calls = 0;
    const callLLM = async () => { calls++; return "should never run"; };
    for (const bad of ["", "   ", "\n\t "]) {
      const out = await answerQuestion(bad, { loadAggregate: async () => fixture(), callLLM });
      assert.strictEqual(out.ok, false, `"${JSON.stringify(bad)}" is rejected`);
      assert.strictEqual(out.status, 400, "empty question is a 400");
      assert.ok(out.error && !out.answer, "carries an error message, no fake answer");
    }
    assert.strictEqual(calls, 0, "the provider was never called for empty questions");
  }

  // 7. Over-length questions are rejected (not silently truncated), before any provider OR DB call.
  {
    let calls = 0, loads = 0;
    const callLLM = async () => { calls++; return "should never run"; };
    const out = await answerQuestion("a".repeat(301), { loadAggregate: async () => { loads++; return fixture(); }, callLLM });

    assert.strictEqual(out.ok, false, "over-length is rejected");
    assert.strictEqual(out.status, 400, "over-length is a 400");
    assert.match(out.error, /too long/i, "message explains it's too long");
    assert.strictEqual(calls, 0, "no provider call for an over-length question");
    assert.strictEqual(loads, 0, "no DB load for an over-length question either");
  }

  // 8. A total provider failure returns a graceful message — never throws, never a fake answer.
  {
    const boom = async () => { throw new Error("all providers down"); };
    const out = await answerQuestion("What is the recovery rate?", { loadAggregate: async () => fixture(), callLLM: boom });

    assert.strictEqual(out.ok, false, "failure result is not ok");
    assert.strictEqual(out.status, 503, "provider failure maps to 503");
    assert.match(out.error, /try again/i, "graceful, human-readable error message");
    assert.ok(!out.answer, "no fabricated answer on failure");
  }

  // 9. buildAskPrompt carries both the aggregate and the recent traces (belt-and-suspenders on #5).
  {
    const p = buildAskPrompt(fixture(), "how many payments were lost?");
    assert.ok(p.includes("\"recovery_rate_pct\":50"), "ask prompt keeps the computed aggregate");
    assert.ok(p.includes("pay_TEST123"), "ask prompt includes recent[] traces");
    assert.ok(p.includes("how many payments were lost?"), "ask prompt appends the question");
  }

  // ── cache stampede + provider timeout (the page-load latency fix) ──

  // 10. Single-flight: concurrent generateInsight() calls while the first is still awaiting the provider
  //     coalesce onto ONE in-flight request — the provider (and the DB load) is hit once, not once per
  //     caller. This is the cache-stampede fix: the dashboard's 5s poll and a StrictMode double-mount
  //     would otherwise each miss the still-empty cache and fire their own ~multi-second provider call.
  {
    _clearCache();
    let calls = 0, loads = 0, release;
    const gate = new Promise((r) => { release = r; }); // hold the provider open so both callers overlap
    const deps = {
      loadAggregate: async () => { loads++; return fixture(); },
      callLLM: async () => { calls++; await gate; return "coalesced summary"; },
    };
    const a = generateInsight(deps);
    const b = generateInsight(deps); // arrives while `a` is still awaiting the gated provider
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.strictEqual(calls, 1, "the provider was called once for two concurrent requests (single-flight)");
    assert.strictEqual(loads, 1, "the aggregate was loaded once, too");
    assert.strictEqual(ra.summary, "coalesced summary", "the originating caller gets the summary");
    assert.deepStrictEqual(rb, ra, "the coalesced caller gets the identical value");

    // The slot is released after resolution and the value is cached — a later call is a plain cache hit.
    const c = await generateInsight(deps);
    assert.strictEqual(calls, 1, "the follow-up call is served from cache, not a new provider call");
    assert.deepStrictEqual(c, ra, "cache returns the coalesced value");
  }

  // 11. Insights + Ask pass a short openrouter timeout (INSIGHTS_OPENROUTER_TIMEOUT_MS, default 8000ms)
  //     as the 3rd arg to the provider chain, so the slow Nemotron leg can't block a user-facing page
  //     load for the full 30s classification tolerates. BOTH call sites (summary + ask) pass it.
  {
    _clearCache();
    let sumTimeout;
    const sumSpy = async (_system, _user, timeoutMs) => { sumTimeout = timeoutMs; return "summary"; };
    await generateInsight({ loadAggregate: async () => fixture(), callLLM: sumSpy });
    assert.strictEqual(sumTimeout, 8000, "generateInsight passes the short 8s openrouter timeout to the chain");

    let askTimeout;
    const askSpy = async (_system, _user, timeoutMs) => { askTimeout = timeoutMs; return "answer"; };
    const out = await answerQuestion("How many payments were lost?", { loadAggregate: async () => fixture(), callLLM: askSpy });
    assert.ok(out.ok, "the ask still succeeds");
    assert.strictEqual(askTimeout, 8000, "answerQuestion passes the short 8s openrouter timeout to the chain");
  }

  // 12. A FAILED generation must not leave a stuck in-flight promise (inflight is cleared whether the
  //     run succeeds, degrades, or throws). The reachable failure is a data-load error: generateInsight
  //     never throws — it returns an UNCACHED graceful message — and the `finally` releases the slot, so
  //     the very next call runs a brand-new generation instead of coalescing forever onto the dead one
  //     (or being served a cached failure).
  {
    _clearCache();
    let loads = 0, calls = 0, failLoad = true;
    const deps = {
      loadAggregate: async () => { loads++; if (failLoad) throw new Error("db unavailable"); return fixture(); },
      callLLM: async () => { calls++; return "recovered summary text"; },
    };

    const failed = await generateInsight(deps);
    assert.match(failed.summary, /unavailable/i, "a failed generation returns a graceful message, never throws");
    assert.strictEqual(calls, 0, "the provider was never reached — the load failed first");

    // inflight was released in `finally`: the next call runs a fresh generation (load ran again) and
    // succeeds — proving the failure left no stuck promise and no cached failure.
    failLoad = false;
    const recovered = await generateInsight(deps);
    assert.strictEqual(loads, 2, "the retry ran a brand-new generation — inflight was not stuck");
    assert.strictEqual(calls, 1, "the fresh generation reached the provider");
    assert.strictEqual(recovered.summary, "recovered summary text", "the retry produced a real summary");
  }

  // 13. Classification is UNTOUCHED — it must keep its own 30s openrouter timeout, independent of the
  //     8s insights timeout proven in #11. classificationService is on the webhook critical path and
  //     exposes no callLLM seam (it calls providers directly), so this is a source-level regression
  //     guard: it fails loudly if the insights latency fix ever bleeds the short 8s timeout into the
  //     classifier, or if classification's 30s default is quietly changed.
  {
    const fs = require("fs");
    const path = require("path");
    const clsSrc = fs.readFileSync(path.join(__dirname, "classificationService.js"), "utf8");

    assert.match(
      clsSrc,
      /OPENROUTER_TIMEOUT_MS\s*=\s*Number\(process\.env\.OPENROUTER_TIMEOUT_MS\)\s*\|\|\s*30000/,
      "classification still defaults its openrouter timeout to 30000ms (30s)"
    );
    assert.match(clsSrc, /timeout:\s*OPENROUTER_TIMEOUT_MS/, "classification's openrouter leg uses the 30s constant");
    assert.ok(!clsSrc.includes("INSIGHTS_OPENROUTER_TIMEOUT_MS"), "the insights 8s timeout is not referenced in classification");
    assert.ok(!/\b8000\b/.test(clsSrc), "classification contains no hardcoded 8000ms timeout");

    // And insights keeps the short 8s default (complements the behavioral check in #11).
    const insSrc = fs.readFileSync(path.join(__dirname, "insightsService.js"), "utf8");
    assert.match(
      insSrc,
      /INSIGHTS_OPENROUTER_TIMEOUT_MS\s*=\s*Number\(process\.env\.INSIGHTS_OPENROUTER_TIMEOUT_MS\)\s*\|\|\s*8000/,
      "insights defaults its openrouter timeout to 8000ms (8s)"
    );
  }

  // 14. Count-based vs money-based rate discrepancy guard:
  //     An aggregate where count-based rate (1/9 = 11%) differs from money-based rate (5000/10000 = 50%)
  //     must use the count-based rate (11%) in compactStats, user prompt, and templated summary.
  {
    _clearCache();
    const aggDivergent = {
      funnel: { failed: 9, classified: 9, recovery_attempted: 5, recovered: 1 },
      money: { recovered: 5000, lost: 5000, currency: "INR" },
      by_reason: [{ reason: "network_timeout", count: 9 }],
      by_strategy: [{ strategy: "payment_link", attempted: 5, succeeded: 1, success_rate: 0.2 }],
      recent: [],
    };

    // Prompt carries count-based 11%, NOT money-based 50%
    const promptText = buildUserPrompt(aggDivergent);
    assert.ok(promptText.includes('"recovery_rate_pct":11'), "prompt carries count-based 11% rate, not money-based 50%");
    assert.ok(!promptText.includes('"recovery_rate_pct":50'), "prompt does not use money-based 50% rate");

    // Fallback template uses count-based 11%
    const fallbackText = templateSummary(aggDivergent);
    assert.match(fallbackText, /11%/, "templated fallback uses count-based 11% rate");

    // Full LLM flow receives system prompt instruction and outputs count-based percentage
    let seenSystem = "", seenUser = "";
    const callLLM = async (system, user) => {
      seenSystem = system;
      seenUser = user;
      return "Recovered ₹5,000 of ₹10,000 (11% recovery rate). Top failure: network_timeout.";
    };
    const res = await generateInsight({ loadAggregate: async () => aggDivergent, callLLM });
    assert.match(res.summary, /11%/, "generated summary matches count-based recovery rate");
    assert.match(seenSystem, /Use the provided recovery_rate_pct value exactly as given/i, "system prompt instructs LLM to use pre-computed rate verbatim");
  }

  console.log("insightsService.test.js: all assertions passed");
})().catch((e) => {
  console.error("self-test crashed (generateInsight should never throw):", e);
  process.exit(1);
});
