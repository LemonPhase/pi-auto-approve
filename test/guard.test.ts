import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults, mergeConfig, type ConfigState } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { Guard } from "../src/guard.js";
import { ApprovalQueue } from "../src/approval.js";
import type { Action, ApprovalProvider, Decision, UserChoice } from "../src/types.js";

const action: Action = { id: "a", tool: "bash", cwd: "/tmp", args: { command: "echo harmless" } };
const ask: Decision = { recommendation: "ask", source: "rule", reason: "confirm" };
const state = (kind: "ask" | "block" | "allow" = "ask"): ConfigState => ({ active: true, errors: [], files: [], config: mergeConfig(defaults, {
  mode: "enforce", audit: { enabled: false }, rules: { [kind]: [{ id: "r", tool: "bash", reason: "confirm" }] },
}) });
const provider = (choice: UserChoice): ApprovalProvider => ({ request: async () => choice });

test("enforce approves exactly once or blocks/rejects without execution", async () => {
  const guard = new Guard(new AuditLog(() => {}), () => {});
  let calls = 0;
  const run = (s: ConfigState, ui?: ApprovalProvider) => guard.execute(action, s, undefined, ui, undefined, async () => ++calls);
  assert.equal(await run(state(), provider("allow_once")), 1);
  await assert.rejects(run(state(), provider("reject")), /rejected/);
  await assert.rejects(run(state("block"), provider("allow_once")), /blocked/);
  assert.equal(calls, 1);
  assert.equal(await run(state("allow")), 2);
});

test("shadow, disabled, invalid configuration, and both non-interactive fallbacks", async () => {
  const guard = new Guard(new AuditLog(() => {}), () => {});
  let calls = 0;
  const noPrompt: ApprovalProvider = { request: async () => { throw Error("unexpected prompt"); } };
  for (const mode of ["shadow", "disabled"] as const) await guard.execute(action, state("block"), mode, noPrompt, undefined, async () => ++calls);
  await guard.execute(action, { ...state("block"), active: false }, undefined, noPrompt, undefined, async () => ++calls);
  await guard.execute(action, state(), undefined, undefined, undefined, async () => ++calls);
  const blocking = state(); blocking.config.approval.non_interactive = "block";
  await assert.rejects(guard.execute(action, blocking, undefined, undefined, undefined, async () => ++calls), /blocked/);
  assert.equal(calls, 4);
});

test("queue serializes prompts, handles overflow, cancels waiting/active calls, and recovers", async () => {
  const queue = new ApprovalQueue();
  const shown: string[] = [];
  const release: ((choice: UserChoice) => void)[] = [];
  const ui: ApprovalProvider = { request: async (a) => { shown.push(a.id); return new Promise(resolve => release.push(resolve)); } };
  const controller = new AbortController();
  const first = queue.request(ui, action, ask, 2, controller.signal);
  const waitingController = new AbortController();
  const second = queue.request(ui, { ...action, id: "b" }, ask, 2, waitingController.signal);
  await assert.rejects(queue.request(ui, { ...action, id: "c" }, ask, 2), /full/);
  assert.deepEqual(shown, ["a"]);
  waitingController.abort();
  await assert.rejects(second, /cancelled/);
  controller.abort();
  await assert.rejects(first, /cancelled/);
  const third = queue.request(ui, { ...action, id: "c" }, ask, 2);
  assert.deepEqual(shown, ["a", "c"]);
  release[1]("allow_once");
  assert.equal(await third, "allow_once");
  release[0]("allow_once"); // Late approval cannot revive the cancelled call.
});

test("approval uses its original config snapshot and abort never delegates", async () => {
  const guard = new Guard(new AuditLog(() => {}), () => {});
  const s = state();
  let release!: (choice: UserChoice) => void;
  let opened!: () => void;
  const started = new Promise<void>(resolve => { opened = resolve; });
  const ui: ApprovalProvider = { request: () => { opened(); return new Promise(resolve => { release = resolve; }); } };
  let calls = 0;
  const controller = new AbortController();
  const pending = guard.execute(action, s, undefined, ui, controller.signal, async () => ++calls);
  await started;
  s.config.mode = "disabled";
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  release("allow_once");
  assert.equal(calls, 0);
});

test("audit logs outcomes with restrictive permissions and no bodies; audit failure does not block", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-audit-"));
  try {
    const s = state("allow");
    s.config.audit = { enabled: true, path: join(root, "audit.jsonl"), include_redacted_action: true };
    const log = new AuditLog(() => {});
    const guard = new Guard(log, () => {});
    const write: Action = { ...action, tool: "write", args: { path: "file", content: "PRIVATE BODY" } };
    s.config.rules.allow = [{ id: "write", tool: "write", reason: "allow" }];
    await guard.execute(write, s, undefined, undefined, undefined, async () => "done");
    const text = await readFile(s.config.audit.path, "utf8");
    assert.ok(!text.includes("PRIVATE BODY"));
    assert.deepEqual(text.trim().split("\n").map(line => JSON.parse(line).outcome), ["evaluated", "execution_started", "executed"]);
    assert.equal((await stat(s.config.audit.path)).mode & 0o777, 0o600);
    // With the file flag off, the file drops the summary but memory keeps it for /guard-last.
    s.config.audit.include_redacted_action = false;
    await guard.execute(write, s, undefined, undefined, undefined, async () => "again");
    const lastLine = (await readFile(s.config.audit.path, "utf8")).trim().split("\n").at(-1)!;
    assert.ok(!JSON.parse(lastLine).action, "file omits the summary unless opted in");
    assert.ok(log.recent.at(-1)!.action, "memory keeps the summary for /guard-last");
    let warnings = 0;
    const failingLog = new AuditLog(() => { warnings++; });
    s.config.audit.path = root; // Opening a directory as a log fails.
    assert.equal(await new Guard(failingLog, () => {}).execute(write, s, undefined, undefined, undefined, async () => "still runs"), "still runs");
    assert.ok(warnings > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fake classifier runs through the complete approval flow and disabled mode bypasses it", async () => {
  let classifications = 0;
  let prompts = 0;
  let executions = 0;
  const guard = new Guard(new AuditLog(() => {}), () => {}, { classify: async () => {
    classifications++;
    return { recommendation: "ask", approveProbability: 0.1, model: "fake", latencyMs: 0 };
  } });
  const s = state(); s.config.rules.ask = [];
  const ui: ApprovalProvider = { request: async () => { prompts++; return "allow_once"; } };
  await guard.execute(action, s, undefined, ui, undefined, async () => ++executions);
  await guard.execute(action, s, "disabled", ui, undefined, async () => ++executions);
  assert.deepEqual([classifications, prompts, executions], [1, 1, 2]);
});

test("mode changes while a prompt is waiting cannot bypass rejection", async () => {
  const s = state();
  const guard = new Guard(new AuditLog(() => {}), () => {});
  let calls = 0;
  const ui: ApprovalProvider = { request: async () => { s.config.mode = "shadow"; return "reject"; } };
  await assert.rejects(guard.execute(action, s, undefined, ui, undefined, async () => ++calls), /rejected/);
  assert.equal(calls, 0);
});

test("UI failure follows configured non-interactive fallback", async () => {
  const guard = new Guard(new AuditLog(() => {}), () => {});
  const ui: ApprovalProvider = { request: async () => { throw Error("UI unavailable"); } };
  let calls = 0;
  const s = state();
  await guard.execute(action, s, undefined, ui, undefined, async () => ++calls);
  s.config.approval.non_interactive = "block";
  await assert.rejects(guard.execute(action, s, undefined, ui, undefined, async () => ++calls), /blocked/);
  assert.equal(calls, 1);
});

test("shadow evaluates the fake classifier but never prompts", async () => {
  let classifications = 0;
  let prompts = 0;
  const guard = new Guard(new AuditLog(() => {}), () => {}, { classify: async () => {
    classifications++;
    return { recommendation: "ask", approveProbability: 0.01, model: "fake", latencyMs: 0 };
  } });
  const s = state(); s.config.rules.ask = [];
  const result = await guard.execute(action, s, "shadow", { request: async () => { prompts++; return "reject"; } }, undefined, async () => "executed");
  assert.equal(result, "executed");
  assert.equal(classifications, 1);
  assert.equal(prompts, 0);
});
