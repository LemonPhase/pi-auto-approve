import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBashToolDefinition, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
  type ToolDefinition, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { registerAutoApprove } from "../src/extension.js";
import type { ApprovalClassifier } from "../src/types.js";

type Answer = Awaited<ReturnType<ApprovalClassifier["classify"]>>;

/** Minimal extension runtime: one builtin bash tool, a fake classifier, and captured UI notifications. */
async function harness(answer: Answer) {
  const root = await mkdtemp(join(tmpdir(), "guard-drift-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "agent"));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi/auto-approve.yaml"), "audit:\n  enabled: false\n");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const infos: ToolInfo[] = [{
    ...createBashToolDefinition(root),
    sourceInfo: { path: "<builtin:bash>", source: "builtin", scope: "user", origin: "top-level" },
  }];
  let start!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  const pi = {
    on: (event: string, handler: typeof start) => { if (event === "session_start") start = handler; },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    getAllTools: () => infos,
    getActiveTools: () => ["bash"],
    setActiveTools: () => {},
    refreshTools: () => {},
  } as unknown as ExtensionAPI;
  const notes: { text: string; warning: boolean }[] = [];
  const ctx = {
    cwd: root, hasUI: true, mode: "rpc", isProjectTrusted: () => false,
    ui: { notify: (text: string, kind?: string) => { notes.push({ text, warning: kind === "warning" }); } },
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getBranch: () => [] },
  } as unknown as ExtensionContext;
  registerAutoApprove(pi, { classify: async () => answer });
  await start({ type: "session_start", reason: "startup" }, ctx);
  return {
    notes,
    run: () => tools.get("bash")!.execute("call-1", { command: "echo drift" }, undefined, undefined, ctx),
    status: async () => { await commands.get("guard-status")!.handler("", ctx as ExtensionCommandContext); return notes.at(-1)!.text; },
    async close() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("model drift warns once through the deduped path naming both models", async () => {
  const answer: Answer = { recommendation: "approve", approveProbability: 0.99, model: "jev-2.0.0", requestedModel: "jev-1.13.0", latencyMs: 1 };
  const h = await harness(answer);
  try {
    await h.run();
    await h.run();
    let drifts = h.notes.filter(note => note.warning && note.text.includes("drift"));
    assert.equal(drifts.length, 1, "warns once even after repeated drifted responses");
    assert.match(drifts[0].text, /jev-1\.13\.0/);
    assert.match(drifts[0].text, /jev-2\.0\.0/);
    answer.model = "jev-1.13.0"; // No drift: a mapped or matched model must stay quiet.
    await h.run();
    drifts = h.notes.filter(note => note.warning && note.text.includes("drift"));
    assert.equal(drifts.length, 1);
  } finally { await h.close(); }
});

test("/guard-status shows the last reported model next to classifier state", async () => {
  const h = await harness({ recommendation: "approve", approveProbability: 0.99, model: "jev-2.0.0", requestedModel: "jev-1.13.0", latencyMs: 1 });
  try {
    assert.match(await h.status(), /Classifier:.*\n\s+Last reported model: none/);
    await h.run();
    assert.match(await h.status(), /Classifier:.*\n\s+Last reported model: jev-2\.0\.0/);
  } finally { await h.close(); }
});
