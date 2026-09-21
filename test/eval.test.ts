import assert from "node:assert/strict";
import test from "node:test";
import { defaults } from "../src/config.js";
import { evaluate } from "../src/policy.js";
import { supportedTools, type ApprovalClassifier } from "../src/types.js";
import { cases } from "./evals/cases.js";
import { summarize, type Outcome } from "./evals/score.js";

test("evaluation cases are well formed and cover both groups", () => {
  const ids = cases.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
  assert.deepEqual([...new Set(cases.map(item => item.group))].sort(), ["heldout", "tuning"]);
  for (const item of cases) {
    assert.ok(["approve", "ask"].includes(item.expected), item.id);
    assert.ok((supportedTools as readonly string[]).includes(item.action.tool), item.id);
    assert.equal(item.action.id, item.id);
  }
  for (const group of ["tuning", "heldout"] as const) {
    const selected = cases.filter(item => item.group === group);
    assert.ok(selected.some(item => item.kind === "routine"), group);
    assert.ok(selected.some(item => item.kind === "dangerous"), group);
  }
});

test("scoring counts misses, unnecessary prompts, errors, and latency", () => {
  const summary = summarize([
    { id: "a", group: "tuning", expected: "ask", actual: "approve", latencyMs: 10 },
    { id: "b", group: "tuning", expected: "approve", actual: "ask", latencyMs: 30 },
    { id: "c", group: "heldout", expected: "ask", actual: "ask", latencyMs: 20 },
    { id: "d", group: "heldout", expected: "approve", actual: "approve", errorCategory: "timeout" },
  ]);
  assert.equal(summary.tuning.total, 2);
  assert.deepEqual(summary.tuning.missedIds, ["a"]);
  assert.deepEqual(summary.tuning.unnecessaryIds, ["b"]);
  assert.equal(summary.tuning.errors, 0);
  assert.equal(summary.tuning.p50LatencyMs, 10);
  assert.equal(summary.tuning.maxLatencyMs, 30);
  assert.deepEqual(summary.heldout.errorIds, ["d"]);
  assert.equal(summary.heldout.errors, 1);
  assert.equal(summary.heldout.p50LatencyMs, 20);
});

test("the evaluation pipeline consumes every case without a network", async () => {
  let calls = 0;
  const stub: ApprovalClassifier = { classify: async () => {
    calls++; return { recommendation: "approve", approveProbability: 0.9, model: "stub", latencyMs: 1 };
  } };
  const outcomes: Outcome[] = [];
  for (const item of cases) {
    const decision = await evaluate(item.action, defaults, stub);
    outcomes.push({ id: item.id, group: item.group, expected: item.expected, actual: decision.recommendation,
      errorCategory: decision.errorCategory, latencyMs: decision.classifier?.latencyMs });
  }
  assert.equal(calls, cases.length);
  const summary = summarize(outcomes);
  assert.equal(summary.tuning.errors, 0);
  assert.equal(summary.heldout.errors, 0);
  assert.equal(summary.heldout.misses, 5, "an always-approve stub must miss every held-out danger");
});
