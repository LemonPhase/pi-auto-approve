import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults, loadConfig, mergeConfig } from "../src/config.js";

test("project overrides scalars and replaces arrays while inheriting missing keys", () => {
  const user = mergeConfig(defaults, { mode: "enforce", rules: { block: [{ id: "block", tool: "bash", reason: "blocked" }] }, classifier: { input: { max_action_chars: 100 } } });
  const project = mergeConfig(user, { mode: "shadow", rules: { block: [] }, classifier: { enabled: false } }, true);
  assert.equal(project.mode, "shadow");
  assert.deepEqual(project.rules.block, []);
  assert.equal(project.classifier.input.max_action_chars, 100);
  assert.equal(project.classifier.enabled, false);
  assert.equal(user.rules.block.length, 1);
  assert.deepEqual(project.rules.allow.map(r => r.id), ["default-allow-read", "default-allow-find", "default-allow-grep", "default-allow-ls"], "unspecified rule lists inherit the defaults");
  assert.equal(defaults.mode, "shadow");
});

test("rejects unknown keys, nulls, invalid enums/bounds, and invalid matchers", () => {
  for (const input of [
    { unknown: true }, { mode: null }, { mode: "yolo" }, { version: 2 }, { classifier: { wat: true } },
    { approval: { max_pending_prompts: 0 } }, { classifier: { approve_probability_min: 1.1 } },
    { rules: { ask: [{ id: "a", tool: "read", reason: "x", command_contains: "rm" }] } },
    { rules: { ask: [{ id: "a", tool: "bash", reason: "x", command_contains: "" }] } },
    { rules: { ask: [{ id: "a", tool: "bash", reason: "x", command_contains: "x", command_exact: "x" }] } },
    { rules: { ask: [{ id: "a", tool: "bash", reason: "x", path_exact: "x" }] } },
  ]) assert.throws(() => mergeConfig(defaults, input), JSON.stringify(input));
  assert.throws(() => mergeConfig(defaults, { load_project_config: false }, true), /user-only/);
});

test("project config loads only for trusted projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-trust-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  await mkdir(join(root, ".pi"));
  try {
    await writeFile(join(root, ".pi/auto-approve.yaml"), "mode: disabled\n");
    const untrusted = await loadConfig(root, agent, false);
    assert.equal(untrusted.config.mode, "shadow");
    assert.deepEqual(untrusted.files, [], "untrusted project file must not load");
    assert.equal((await loadConfig(root, agent, true)).config.mode, "disabled");
    assert.equal((await loadConfig(root, agent)).config.mode, "shadow", "untrusted is the safe default");
    await writeFile(join(agent, "pi-auto-approve.yaml"), "load_project_config: false\nmode: enforce\n");
    assert.equal((await loadConfig(root, agent, true)).config.mode, "enforce", "user opt-out still wins for trusted projects");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config files: missing, disabled project loading, malformed reload, recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "guard-config-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  await mkdir(join(root, ".pi"));
  try {
    assert.equal((await loadConfig(root, agent, true)).active, true);
    await writeFile(join(agent, "pi-auto-approve.yaml"), "load_project_config: false\nmode: enforce\n");
    await writeFile(join(root, ".pi/auto-approve.yaml"), "mode: [malformed\n");
    assert.equal((await loadConfig(root, agent, true)).config.mode, "enforce");
    await writeFile(join(agent, "pi-auto-approve.yaml"), "mode: enforce\n");
    const failed = await loadConfig(root, agent, true);
    assert.equal(failed.active, false);
    assert.equal(failed.config.mode, "shadow", "must not retain partial user settings");
    assert.match(failed.errors[0], /auto-approve.yaml/);
    await writeFile(join(root, ".pi/auto-approve.yaml"), "mode: disabled\n");
    assert.equal((await loadConfig(root, agent, true)).config.mode, "disabled");
    await writeFile(join(root, ".pi/auto-approve.yaml"), "mode: shadow\nmode: enforce\n");
    assert.equal((await loadConfig(root, agent, true)).active, false, "duplicate YAML keys rejected");
    await writeFile(join(root, ".pi/auto-approve.yaml"), "classifier:\n  timeout_ms: super-secret-value\n");
    const diagnostic = (await loadConfig(root, agent, true)).errors.join();
    assert.ok(!diagnostic.includes("super-secret-value"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
