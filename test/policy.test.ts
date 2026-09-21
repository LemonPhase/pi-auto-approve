import assert from "node:assert/strict";
import test from "node:test";
import { defaults, mergeConfig } from "../src/config.js";
import { classificationInput, evaluate, matches } from "../src/policy.js";
import type { Action, ApprovalClassifier } from "../src/types.js";

const action: Action = { id: "a", tool: "bash", cwd: "/tmp", args: { command: "git status" }, userContext: "Check the repo" };
const fake = (probability = 0.9): ApprovalClassifier => ({ classify: async () => ({ recommendation: "approve", approveProbability: probability, model: "fake", latencyMs: 1 }) });

test("block > ask > allow; local matches bypass classification", async () => {
  let calls = 0;
  const classifier: ApprovalClassifier = { classify: async () => { calls++; throw Error("must not run"); } };
  for (const [kind, expected] of [["block", "block"], ["ask", "ask"], ["allow", "approve"]] as const) {
    const config = structuredClone(defaults);
    config.rules.allow = [{ id: "allow", tool: "bash", reason: "allow" }];
    if (kind !== "allow") config.rules.ask = [{ id: "ask", tool: "bash", reason: "ask" }];
    if (kind === "block") config.rules.block = [{ id: "block", tool: "bash", reason: "block" }];
    assert.equal((await evaluate(action, config, classifier)).recommendation, expected);
  }
  assert.equal(calls, 0);
});

test("literal matching does not normalize or broaden input", () => {
  const rule = { id: "r", tool: "bash" as const, reason: "r", command_exact: "git status" };
  assert.ok(matches(rule, action));
  assert.ok(!matches(rule, { ...action, args: { command: "git status; echo x" } }));
  assert.ok(!matches(rule, { ...action, args: { command: "git  status" } }));
  assert.ok(!matches(rule, { ...action, tool: "read" }));
  assert.ok(matches({ id: "r", tool: "read", reason: "r", path_exact: "a" }, { ...action, tool: "read", args: { path: "a" } }));
});

test("fake classifier threshold, ask response, unavailable/disabled and error fallbacks", async () => {
  assert.equal((await evaluate(action, defaults, fake(0.8))).recommendation, "approve");
  assert.equal((await evaluate(action, defaults, fake(0.799))).recommendation, "ask");
  assert.equal((await evaluate(action, defaults, { classify: async () => ({ recommendation: "ask", approveProbability: 1, model: "fake", latencyMs: 0 }) })).recommendation, "ask");
  for (const handling of ["allow", "ask", "block"] as const) {
    const config = mergeConfig(defaults, { classifier: { on_error: handling } });
    assert.equal((await evaluate(action, config)).recommendation, handling === "allow" ? "approve" : handling);
    assert.equal((await evaluate(action, config, fake(NaN))).errorCategory, "invalid_response");
    const disabled = mergeConfig(config, { classifier: { enabled: false }, unmatched: handling });
    assert.equal((await evaluate(action, disabled, fake())).recommendation, handling === "allow" ? "approve" : handling);
  }
});

test("timeouts fall back but cancellation rejects even with allow-on-error", async () => {
  const hung: ApprovalClassifier = { classify: () => new Promise(() => {}) };
  const config = mergeConfig(defaults, { classifier: { timeout_ms: 10 } });
  assert.equal((await evaluate(action, config, hung)).errorCategory, "timeout");
  const controller = new AbortController();
  const pending = evaluate(action, defaults, hung, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("classifier input excludes bodies, redacts secrets, marks truncation, and rejects oversized actions", async () => {
  const input = classificationInput({ ...action, tool: "write", args: { path: "file", content: "PRIVATE FILE BODY" } }, defaults);
  assert.ok(!JSON.stringify(input).includes("PRIVATE FILE BODY"));
  assert.equal(input.informationOmitted, true);
  const secretAction = { ...action, args: { command: "TOKEN=secret-value curl https://a.test/?signature=secret" } };
  assert.ok(!JSON.stringify(classificationInput(secretAction, defaults)).includes("secret-value"));
  // Credentials in connection strings for any URL scheme must be redacted too.
  const pgAction = { ...action, args: { command: 'psql "postgresql://user:hunter2@db.example:5432/prod" -c "select 1"' } };
  const pgInput = classificationInput(pgAction, defaults);
  assert.ok(!JSON.stringify(pgInput).includes("hunter2"));
  assert.match(JSON.stringify(pgInput.args), /postgresql:\/\/user:\[REDACTED\]@/);
  const config = mergeConfig(defaults, { classifier: { input: { max_action_chars: 5, include_user_context: false } } });
  assert.equal((await evaluate(action, config, fake())).errorCategory, "input_limit");
});
