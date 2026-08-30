// Run: node src/services/orchestratorService.test.js   (or: npm run test:orchestrator)  — pure, no DB/API.
// Checks the escalation state machine's decision table: what runs next when a strategy fails or times
// out, and where the chain terminates (→ payment marked lost). The async I/O around it (mocked resolve
// timers, the payment_link timeout claim, the payment_link.paid mirror guard) is verified live via
// scripts/inject.js + the dashboard — see phase-5.md acceptance criteria; this pins the pure branching.
const assert = require("assert");
const { nextStrategy, timeoutMs } = require("./orchestratorService");

// auto_retry fails → payment_link (Step 2)
let r = nextStrategy("auto_retry", "fail");
assert.strictEqual(r.next, "payment_link", "auto_retry fail → payment_link");
assert.strictEqual(r.terminal, false, "auto_retry fail is not terminal");

// payment_link times out → alt_method (Step 3)
r = nextStrategy("payment_link", "timeout");
assert.strictEqual(r.next, "alt_method", "payment_link timeout → alt_method");
assert.strictEqual(r.terminal, false, "payment_link timeout is not terminal");

// alt_method fails → terminal, no next strategy (Step 4 → mark lost)
r = nextStrategy("alt_method", "fail");
assert.strictEqual(r.next, null, "alt_method fail has no next strategy");
assert.strictEqual(r.terminal, true, "alt_method fail is terminal");

// payment_link has no onFail route (its failure mode is timeout, not a mocked fail) — never escalates
// on a plain 'fail' signal, and is NOT terminal (a timeout can still route it forward).
r = nextStrategy("payment_link", "fail");
assert.strictEqual(r.next, null, "payment_link has no onFail route");
assert.strictEqual(r.terminal, false, "payment_link fail is not terminal (only its timeout routes it)");

// auto_retry has no timeout route
assert.strictEqual(nextStrategy("auto_retry", "timeout").next, null, "auto_retry has no timeout route");

// Timeout window: only payment_link has one, and it's positive; others are 0.
assert.ok(timeoutMs("payment_link") > 0, "payment_link has a positive timeout window");
assert.strictEqual(timeoutMs("auto_retry"), 0, "auto_retry has no timeout window");
assert.strictEqual(timeoutMs("alt_method"), 0, "alt_method has no timeout window");

console.log("orchestratorService.test.js: all assertions passed");
