import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapTool } from "../src/tools.js";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

type Args = Parameters<BashDefinition["execute"]>;
// The real delegate accepts an absent context and falls back to its supplied cwd.
const noContext = undefined as unknown as Args[4];

test("preserves metadata, arguments, streaming, signal, context, and result identity", async () => {
  const original = createBashToolDefinition(process.cwd());
  const result = { content: [{ type: "text" as const, text: "done" }], details: undefined };
  const args: Args = ["call-1", { command: "printf test", timeout: 2 }, new AbortController().signal, () => {}, noContext];
  let calls = 0;
  let observations = 0;
  const delegate: BashDefinition = { ...original, execute: async (...received) => {
    calls++;
    received.forEach((value, i) => assert.equal(value, args[i]));
    received[3]?.(result);
    return result;
  } };
  let updates = 0;
  args[3] = (update) => { assert.equal(update, result); updates++; };
  const wrapped = wrapTool(delegate, (received, next) => {
    assert.equal(received[0], "call-1");
    observations++;
    return next();
  });
  for (const key of Object.keys(delegate) as (keyof BashDefinition)[]) {
    if (key !== "execute") assert.equal(wrapped[key], delegate[key]);
  }
  assert.equal(await wrapped.execute(...args), result);
  assert.equal(calls, 1);
  assert.equal(updates, 1);
  assert.equal(observations, 1);
});

test("preserves delegate error identity", async () => {
  const failure = new Error("delegate failure");
  const delegate: BashDefinition = { ...createBashToolDefinition(process.cwd()), execute: async () => { throw failure; } };
  const wrapped = wrapTool(delegate, (_args, next) => next());
  await assert.rejects(wrapped.execute("call", { command: "unused" }, undefined, undefined, noContext), (error) => error === failure);
});

test("real Bash preserves cwd, output, and nonzero-exit behaviour", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-auto-approve-test-"));
  try {
    const direct = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
    const wrapped = wrapTool(direct, (_args, next) => next());
    const command = "pwd; printf 'hello\\n'; printf 'error\\n' >&2";
    const run = (tool: BashDefinition, text: string) => tool.execute("test", { command: text }, undefined, undefined, noContext);
    assert.deepEqual(await run(wrapped, command), await run(direct, command));
    await assert.rejects(run(wrapped, "exit 7"), /7/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real Bash forwards cancellation", async () => {
  const controller = new AbortController();
  const wrapped = wrapTool(createBashToolDefinition(process.cwd()), (_args, next) => next());
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(wrapped.execute("cancel", { command: "sleep 10" }, controller.signal, undefined, noContext), /abort/i);
  } finally {
    clearTimeout(timer);
  }
});
