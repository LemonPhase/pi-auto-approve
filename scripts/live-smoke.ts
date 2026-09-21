/** Opt-in end-to-end check: uses the installed Pi package and existing provider credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

// Classifier configuration used by the Jev section below.
const jevConfiguration = `mode: enforce
classifier:
  enabled: true
  model: jev-1.13.0
  timeout_ms: 1500
  on_error: block
  approve_probability_min: 0.8
audit:
  path: ${JSON.stringify(logPath)}
`;

// A local stand-in for the Jev endpoint: same request/response shape, no key or quota.
let jevMode: "approve" | "ask" | "error" = "approve";
const jevRequests: { headers: Record<string, unknown>; body: any }[] = [];
const jevServer = createServer((request, response) => {
  let raw = "";
  request.on("data", chunk => { raw += String(chunk); });
  request.on("end", () => {
    let body: any;
    try { body = JSON.parse(raw); } catch { body = raw; }
    jevRequests.push({ headers: request.headers as Record<string, unknown>, body });
    if (jevMode === "error") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    const decision = jevMode === "approve"
      ? { type: "choice", choice: "approve", confidence: 1, probabilities: { approve: 0.95, ask: 0.05 } }
      : { type: "choice", choice: "ask", confidence: 1, probabilities: { approve: 0.2, ask: 0.8 } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "jev-1.13.0", answers: { decision }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise<void>(resolve => jevServer.listen(0, "127.0.0.1", resolve));
const jevEndpoint = `http://127.0.0.1:${(jevServer.address() as { port: number }).port}/v1/systemone`;

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "bash", "--thinking", "off"], {
  cwd: directory, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, TYPESAFE_API_KEY: "stub-key", TYPESAFE_API_URL: jevEndpoint },
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

  await writeFile(configPath, jevConfiguration);
  await send("prompt", { message: "/guard-reload" });

  jevMode = "approve";
  await prompt("printf JEV_APPROVE > jev-approved.txt");
  assert.equal(await readFile(join(directory, "jev-approved.txt"), "utf8"), "JEV_APPROVE");
  console.log("PASS Jev approval recommendation executes without prompting");

  jevMode = "ask";
  approval = "Allow once";
  const jevAsked = await prompt("printf JEV_ASK > jev-asked.txt");
  assert.ok(jevAsked.some(e => e.type === "extension_ui_request" && e.method === "select"), "Jev ask must prompt");
  assert.equal(await readFile(join(directory, "jev-asked.txt"), "utf8"), "JEV_ASK");
  console.log("PASS Jev ask recommendation prompts and honours the user choice");

  jevMode = "error";
  await prompt("printf JEV_FAIL > jev-blocked.txt");
  assert.equal(await exists(join(directory, "jev-blocked.txt")), false);
  console.log("PASS Jev failure follows classifier.on_error=block");

  const jevRequest = jevRequests.at(-1)!;
  assert.equal(jevRequest.headers.authorization, "Bearer stub-key");
  assert.match(JSON.stringify(jevRequest.body), /JEV_FAIL/);
  assert.ok(jevRequest.body.questions.decision.instructions.length > 0, "the rubric travels in the question instructions");
  for (const item of jevRequests) assert.ok(!JSON.stringify(item.body).includes("stub-key"), "the credential must stay in the header");
  console.log(`PASS ${jevRequests.length} Jev requests carried the action, the rubric, and no credential in the body`);

  // Shadow mode must record the recommendation without prompting or blocking.
  await send("prompt", { message: "/guard-mode shadow" });
  jevMode = "ask";
  const shadowRun = await prompt("printf JEV_SHADOW > jev-shadow.txt");
  assert.equal(await readFile(join(directory, "jev-shadow.txt"), "utf8"), "JEV_SHADOW");
  assert.ok(!shadowRun.some(e => e.type === "extension_ui_request" && e.method === "select"), "shadow must not prompt");
  console.log("PASS shadow records a Jev ask recommendation and executes without prompting");
  await send("prompt", { message: "/guard-mode enforce" });

  const records = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.some(record => record.source === "jev" && record.classifier?.model === "jev-1.13.0"), "Jev decisions must be recorded");
  assert.ok(records.some(record => record.errorCategory === "unauthorized"), "Jev failures must be recorded");
  console.log(`PASS ${records.length} audit events recorded; Jev traffic used a local stub, not the real API`);
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
  jevServer.close();
  await rm(directory, { recursive: true, force: true });
}
