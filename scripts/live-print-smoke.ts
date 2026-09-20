/** Opt-in check for a real Pi session with no approval UI. Uses existing credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = await mkdtemp(join(tmpdir(), "pi-auto-approve-print-"));
try {
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/auto-approve.yaml"), `mode: enforce
classifier:
  enabled: false
unmatched: ask
approval:
  non_interactive: block
audit:
  path: ${JSON.stringify(join(cwd, "audit.jsonl"))}
`);
  const child = spawn("pi", ["--print", "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "bash", "--thinking", "off",
    "Permission test in a temporary directory: call Bash exactly once with command `printf test > marker.txt`. If blocked, report it without retrying or using another tool. Then stop."], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let warnings = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { warnings += String(chunk); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0, "Pi print session did not complete");
    assert.ok(output.includes('"tool_execution_start"'), "Model did not attempt a tool call");
    await assert.rejects(access(join(cwd, "marker.txt")));
    const records = (await readFile(join(cwd, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(records.some(record => record.outcome === "blocked" && record.handling === "non_interactive"));
    assert.ok(warnings.includes("Mode: enforce"), "Headless startup status missing");
    console.log("PASS installed extension in Pi print mode: ask + non_interactive:block prevents execution and logs the fallback");
  } finally { clearTimeout(timeout); }
} finally { await rm(cwd, { recursive: true, force: true }); }
