import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalProvider, displayJSON } from "../src/approval-ui.js";
import type { Action, Decision } from "../src/types.js";

const action: Action = { id: "a", tool: "bash", args: { command: "echo test" }, cwd: "/tmp" };
const decision: Decision = { recommendation: "ask", source: "rule", reason: "Confirm" };

test("closing an approval rejects and explicit approval allows once", async () => {
  assert.equal(await createApprovalProvider({ select: async () => undefined }).request(action, decision), "reject");
  assert.equal(await createApprovalProvider({ select: async () => "Allow once" }).request(action, decision), "allow_once");
});

test("large payload inspection exposes every character through bounded pages", async () => {
  const large = { ...action, tool: "write", args: { path: "file", content: "abc".repeat(900) } };
  const pages: string[] = [];
  let opened = false;
  const ui = createApprovalProvider({ select: async (title, choices) => {
    if (title.startsWith("Pi Auto Approve")) {
      assert.ok(!title.includes("abcabc"), "file body must not flood the main approval prompt");
      if (opened) return "Allow once";
      opened = true;
      return "Inspect full arguments";
    }
    pages.push(title.slice(title.indexOf("\n") + 1));
    return choices.includes("Next page") ? "Next page" : "Back to approval";
  } });
  assert.equal(await ui.request(large, decision), "allow_once");
  assert.equal(pages.join(""), displayJSON(large.args));
  assert.ok(pages.every(page => page.length <= 600));
});

test("terminal controls and directional overrides are displayed as escapes", () => {
  const text = displayJSON({ command: "echo\u001b[2J\u009b\u202etest" });
  assert.ok(!/[\u001b\u009b\u202e]/.test(text));
  assert.match(text, /\\u202e/);
});
