import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createExtensionRuntime, createBashToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, type ExtensionContext, type ExtensionCommandContext,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { workspaceKey } from "../src/audit.js";
import { clearPersistedKeys, credentialSummary, loadPersistedKeys, persistKey } from "../src/auth.js";

test("real Pi loader registers native wrappers; commands, rules, reload, and native delegation work", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-extension-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousKeys = { direct: process.env.TYPESAFE_API_KEY, gateway: process.env.AI_GATEWAY_API_KEY };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  await mkdir(join(root, "agent"));
  await mkdir(join(root, ".pi"));
  const project = join(root, ".pi/auto-approve.yaml");
  await writeFile(project, "mode: enforce\nclassifier:\n  enabled: false\naudit:\n  enabled: false\n");
  await writeFile(join(root, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: "printf 'prefix-'" }));
  // User config loads regardless of project trust; keep audit off so the untrusted phase
  // writes nothing to the real ~/.pi/agent/logs default.
  await writeFile(join(root, "agent", "pi-auto-approve.yaml"), "audit:\n  enabled: false\n");
  try {
    const runtime = createExtensionRuntime();
    const loaded = await loadExtensions([resolve("src/index.ts")], root, undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const factories = [createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
      createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition];
    const tools = new Map<string, ToolInfo>(factories.map(factory => {
      const tool = factory(root);
      return [tool.name, { ...tool, sourceInfo: { path: `<builtin:${tool.name}>`, source: "builtin", scope: "user", origin: "top-level" } }];
    }));
    let active = ["bash", "read", "write", "edit"];
    runtime.getAllTools = () => [...tools.values()];
    runtime.getActiveTools = () => active;
    runtime.setActiveTools = names => { active = names; };
    runtime.refreshTools = () => {
      for (const [name, registered] of extension.tools) tools.set(name, { ...registered.definition, sourceInfo: registered.sourceInfo });
    };
    const messages: string[] = [];
    let sessionId: string | undefined = "test";
    const ctx = {
      cwd: root, hasUI: true, mode: "rpc", isProjectTrusted: () => false,
      ui: {
        notify: (text: string) => messages.push(text),
        select: async (_title: string, options: string[]) => (options[0] === "Allow once" ? "Allow once" : options[0]),
        input: async () => "test-gateway-key-123",
      },
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getBranch: () => [] },
    } as unknown as ExtensionContext;
    async function start() {
      for (const handler of extension.handlers.get("session_start") ?? [])
        await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    async function command(name: string, args = "") {
      await extension.commands.get(name)!.handler(args, ctx as ExtensionCommandContext);
    }
    async function run(name: string, args: Record<string, unknown>) {
      return extension.tools.get(name)!.definition.execute("test-call", args, undefined, undefined, ctx);
    }
    await start();
    assert.equal(extension.tools.size, 7);
    assert.deepEqual(active, ["bash", "read", "write", "edit"]);
    await run("write", { path: "a.txt", content: "before\n" });
    await run("edit", { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] });
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after\n");
    assert.match(JSON.stringify(await run("read", { path: "a.txt" })), /after/);
    assert.match(JSON.stringify(await run("ls", { path: "." })), /a.txt/);
    assert.match(JSON.stringify(await run("find", { path: ".", pattern: "*.txt" })), /a.txt/);
    assert.match(JSON.stringify(await run("grep", { path: ".", pattern: "after" })), /after/);
    const untrustedOutput = JSON.stringify(await run("bash", { command: "printf working" }));
    assert.match(untrustedOutput, /working/);
    assert.ok(!untrustedOutput.includes("prefix-"), "untrusted shell settings must not change execution");
    // An untrusted project must not load the project layer, and /guard-status must say so.
    await command("guard-status");
    assert.match(messages.at(-1)!, /ignored.*not trusted/);
    assert.match(messages.at(-1)!, /mode: shadow/);
    assert.ok(!messages.at(-1)!.includes(project), "untrusted project file must not be a configuration source");
    ctx.isProjectTrusted = () => true;
    await start();
    assert.match(JSON.stringify(await run("bash", { command: "printf working" })), /prefix-working/);
    await writeFile(project, "mode: enforce\nclassifier:\n  enabled: false\nunmatched: block\naudit:\n  enabled: false\n");
    await command("guard-reload");
    await assert.rejects(run("write", { path: "blocked.txt", content: "never" }), /blocked/);
    await command("guard-mode", "shadow");
    await run("write", { path: "shadow.txt", content: "allowed" });
    await command("guard-reload");
    await assert.rejects(run("write", { path: "blocked-again.txt", content: "never" }), /blocked/);
    await writeFile(project, "mode: invalid");
    await command("guard-reload");
    await command("guard-mode", "enforce");
    assert.match(messages.at(-1)!, /invalid/);
    await run("write", { path: "invalid-config.txt", content: "still runs" });
    await command("guard-status");
    assert.match(messages.at(-1)!, /INACTIVE/);
    assert.match(messages.at(-1)!, /invalid/);
    // Session lifecycle must not lose wrappers or misreport them as custom.
    await start();
    await command("guard-status");
    assert.match(messages.at(-1)!, /Unguarded tools: none/);
    // /guard-login persists a key, activates it in the in-memory store, and reports it; /guard-logout removes both.
    // Keys never reach process.env, so child processes cannot inherit them.
    const envBeforeLogin = { direct: process.env.TYPESAFE_API_KEY, gateway: process.env.AI_GATEWAY_API_KEY };
    await command("guard-login");
    const authFile = join(root, "agent", "pi-auto-approve-auth.json");
    const saved = JSON.parse(await readFile(authFile, "utf8"));
    assert.equal(saved.AI_GATEWAY_API_KEY, "test-gateway-key-123");
    assert.equal(process.env.TYPESAFE_API_KEY, envBeforeLogin.direct);
    assert.equal(process.env.AI_GATEWAY_API_KEY, envBeforeLogin.gateway);
    assert.match(messages.at(-1)!, /ai-gateway\.vercel\.sh/);
    await command("guard-status");
    assert.match(messages.at(-1)!, /Vercel AI Gateway/);
    await command("guard-logout");
    assert.ok(!JSON.parse(await readFile(authFile, "utf8")).AI_GATEWAY_API_KEY);
    assert.equal(process.env.TYPESAFE_API_KEY, envBeforeLogin.direct);
    assert.equal(process.env.AI_GATEWAY_API_KEY, envBeforeLogin.gateway);
    assert.match(messages.at(-1)!, /Removed/);
    // /guard-last renders one human-readable line per call, with the command and no metadata.
    // Audit logs are per session and per workspace: <logs>/<workspace>/<sessionId>.jsonl.
    const logs = join(root, "logs");
    const workspace = join(logs, workspaceKey(root));
    await mkdir(workspace, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const aged = async (dir: string, name: string) => {
      await writeFile(join(dir, name), "");
      await utimes(join(dir, name), old, old);
    };
    await aged(workspace, "old-session.jsonl");
    await aged(logs, "pi-auto-approve-stale.jsonl");
    await aged(logs, "unrelated.jsonl");
    await aged(logs, "pi-auto-approve.jsonl");
    await writeFile(join(workspace, "recent-session.jsonl"), "");
    await writeFile(project, `mode: shadow\nclassifier:\n  enabled: false\naudit:\n  enabled: true\n  path: ${JSON.stringify(join(logs, "pi-auto-approve.jsonl"))}\n`);
    await command("guard-reload");
    await run("write", { path: "last-demo.txt", content: "demo" });
    await command("guard-last");
    const last = messages.at(-1)!;
    assert.match(last, /write/);
    assert.match(last, /ran/);
    assert.match(last, /last-demo\.txt/);
    assert.ok(!last.includes("configFingerprint") && !last.includes("actionHash"), "metadata stays out of the display");
    // The session's records land in one file per session inside the workspace directory.
    const names = await readdir(workspace);
    assert.ok(names.includes("test.jsonl"), "the log file is named for the session id");
    const records = (await readFile(join(workspace, "test.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.some(record => record.tool === "write" && record.outcome === "executed" && record.cwd === root), "records carry the working directory");
    assert.ok(!names.includes("old-session.jsonl"), "old session logs are pruned after 30 days");
    assert.ok(names.includes("recent-session.jsonl"), "recent session logs are kept");
    const rootNames = await readdir(logs);
    assert.ok(!rootNames.includes("pi-auto-approve.jsonl") && !rootNames.includes("pi-auto-approve-stale.jsonl"), "flat logs from previous layouts age out");
    assert.ok(rootNames.includes("unrelated.jsonl"), "non-matching files are untouched");
    sessionId = "weird id/1";
    await run("write", { path: "named.txt", content: "x" });
    sessionId = undefined;
    await run("write", { path: "unnamed.txt", content: "x" });
    const named = await readdir(workspace);
    assert.ok(named.includes("weird_id_1.jsonl"), "unsafe characters in session ids are sanitized");
    assert.ok(named.includes("unknown.jsonl"), "missing session ids fall back to unknown");
    // An external override is left untouched on a later session start.
    tools.set("bash", { ...tools.get("bash")!, sourceInfo: { path: "/custom/remote.ts", source: "extension", scope: "user", origin: "top-level" } });
    await start();
    await command("guard-status");
    assert.match(messages.at(-1)!, /Unguarded tools:.*\bbash\b/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousKeys.direct === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKeys.direct;
    if (previousKeys.gateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previousKeys.gateway;
    await rm(root, { recursive: true, force: true });
  }
});

test("persist, load, and clear of keys never write API-key env vars", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-auth-"));
  const before = { direct: process.env.TYPESAFE_API_KEY, gateway: process.env.AI_GATEWAY_API_KEY };
  try {
    await persistKey(root, "direct", "sk-test-123");
    await persistKey(root, "gateway", "vck-test-123");
    await loadPersistedKeys(root);
    assert.equal(process.env.TYPESAFE_API_KEY, before.direct);
    assert.equal(process.env.AI_GATEWAY_API_KEY, before.gateway);
    assert.equal(credentialSummary(), "direct");
    await clearPersistedKeys(root, ["direct", "gateway"]);
    assert.equal(process.env.TYPESAFE_API_KEY, before.direct);
    assert.equal(process.env.AI_GATEWAY_API_KEY, before.gateway);
    assert.equal(credentialSummary(), before.direct ? "direct" : before.gateway ? "gateway" : "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
