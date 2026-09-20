/** Opt-in end-to-end check: uses the installed Pi package and existing provider credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "pi-auto-approve-live-"));
await mkdir(join(directory, ".pi"));
const configPath = join(directory, ".pi/auto-approve.yaml");
const logPath = join(directory, "audit.jsonl");
const configuration = `mode: enforce
classifier:
  enabled: false
audit:
  path: ${JSON.stringify(logPath)}
rules:
  block:
    - id: block-marker
      tool: bash
      command_contains: BLOCK_MARKER
      reason: Test block rule for a harmless marker command.
  ask:
    - id: ask-marker
      tool: bash
      command_contains: ASK_MARKER
      reason: Test approval for a harmless marker command.
`;
await writeFile(configPath, configuration);
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "bash", "--thinking", "off"], {
  cwd: directory, stdio: ["pipe", "pipe", "pipe"],
});
type Event = Record<string, any>;
const events: Event[] = [];
let buffer = "";
let stderr = "";
let approval = "Allow once";
let exited = false;
child.on("exit", () => { exited = true; });
child.stderr.on("data", chunk => { stderr += String(chunk); });
child.stdout.on("data", chunk => {
  buffer += String(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try {
      const event: Event = JSON.parse(line);
      events.push(event);
      if (event.type === "extension_ui_request" && event.method === "select" && String(event.title).startsWith("Pi Auto Approve")) {
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: approval }) + "\n");
      }
    } catch { /* Ignore non-protocol startup banners. */ }
  }
});
let sequence = 0;
async function waitFor(predicate: (event: Event) => boolean, start = 0, timeout = 120_000): Promise<Event> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = events.slice(start).find(predicate);
    if (found) return found;
    if (exited) throw Error("Pi exited before completing the check");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Timed out waiting for Pi; inspect provider availability");
}
async function send(type: string, fields: Event = {}): Promise<Event> {
  const id = `request-${++sequence}`;
  const start = events.length;
  child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
  const response = await waitFor(e => e.type === "response" && e.id === id, start);
  assert.equal(response.success, true, `${type} failed`);
  return response;
}
async function prompt(command: string): Promise<Event[]> {
  const start = events.length;
  await send("prompt", { message: `This is a permission-extension smoke test in a temporary directory. Run exactly this Bash command once: ${command}\nDo not use any other tools or commands. If blocked, report that and do not retry. Then stop.` });
  await waitFor(e => e.type === "agent_end", start);
  const result = events.slice(start);
  assert.ok(result.some(e => e.type === "tool_execution_start" && e.toolName === "bash"), "Model did not call bash");
  return result;
}
async function exists(name: string): Promise<boolean> { try { await access(join(directory, name)); return true; } catch { return false; } }

try {
  const state = await send("get_state");
  console.log(`Provider ready: ${state.data?.model?.provider ?? "configured provider"}`);
  const start = events.length;
  await send("prompt", { message: "/guard-status" });
  const status = await waitFor(e => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).includes('"coverage"'), start);
  const details = JSON.parse(status.message);
  assert.equal(details.active, true);
  assert.equal(details.mode, "enforce");
  assert.ok(details.coverage.includes("bash"));
  console.log("PASS installed extension loads with Bash coverage");

  await prompt("printf BLOCK_MARKER > blocked.txt");
  assert.equal(await exists("blocked.txt"), false);
  assert.ok((await readFile(logPath, "utf8")).includes('"outcome":"blocked"'));
  console.log("PASS enforce block prevents execution");

  approval = "Allow once";
  const approved = await prompt("printf ASK_MARKER > approved.txt");
  assert.ok(approved.some(e => e.type === "extension_ui_request" && e.method === "select"));
  assert.equal(await readFile(join(directory, "approved.txt"), "utf8"), "ASK_MARKER");
  console.log("PASS RPC approval executes exactly the requested action");

  approval = "Reject";
  await prompt("printf ASK_MARKER > rejected.txt");
  assert.equal(await exists("rejected.txt"), false);
  console.log("PASS RPC rejection prevents execution");

  await send("prompt", { message: "/guard-mode shadow" });
  await prompt("printf BLOCK_MARKER > shadow.txt");
  assert.equal(await exists("shadow.txt"), true);
  console.log("PASS shadow records a block recommendation but executes");

  await writeFile(configPath, "mode: invalid\n");
  await send("prompt", { message: "/guard-reload" });
  await prompt("printf BLOCK_MARKER > invalid-config.txt");
  assert.equal(await exists("invalid-config.txt"), true);
  console.log("PASS invalid config warns and preserves execution");

  await writeFile(configPath, configuration);
  await send("prompt", { message: "/guard-reload" });
  await prompt("printf BLOCK_MARKER > recovered.txt");
  assert.equal(await exists("recovered.txt"), false);
  console.log("PASS valid reload restores enforcement and clears the mode override");
  const records = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  console.log(`PASS ${records.length} audit events recorded; no Jev calls made`);
} catch (error) {
  // Never print provider responses, credentials, or raw tool arguments on failure.
  console.error(`Live check failed: ${(error as Error).message}`);
  console.error(`Observed ${events.length} RPC events; ${stderr.length} stderr characters.`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
  if (!exited) await new Promise(resolve => child.once("exit", resolve));
  clearTimeout(killTimer);
  await rm(directory, { recursive: true, force: true });
}
