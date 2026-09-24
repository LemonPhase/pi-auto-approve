import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { supportedTools } from "./types.js";

const handling = z.enum(["allow", "ask", "block"]);
const nonempty = z.string().min(1);
const positive = z.number().int().positive().max(1_000_000);
const rule = z.strictObject({
  id: nonempty, tool: z.enum(supportedTools), reason: nonempty,
  command_exact: nonempty.optional(), command_contains: nonempty.optional(), path_exact: nonempty.optional(),
}).superRefine((value, ctx) => {
  const matchers = [value.command_exact, value.command_contains, value.path_exact].filter(v => v !== undefined);
  if (matchers.length > 1) ctx.addIssue({ code: "custom", message: "Use at most one argument matcher" });
  if ((value.command_exact !== undefined || value.command_contains !== undefined) && value.tool !== "bash")
    ctx.addIssue({ code: "custom", message: "Command matchers require bash" });
  if (value.path_exact !== undefined && value.tool === "bash")
    ctx.addIssue({ code: "custom", message: "Path matchers require a filesystem tool" });
});
const input = z.strictObject({ include_user_context: z.boolean(), max_user_context_chars: positive, max_action_chars: positive });
const classifier = z.strictObject({
  enabled: z.boolean(), model: nonempty, timeout_ms: positive, on_error: handling,
  approve_probability_min: z.number().min(0).max(1), instructions: nonempty, input,
});
const approval = z.strictObject({ non_interactive: z.enum(["allow", "block"]), max_pending_prompts: positive });
const audit = z.strictObject({ enabled: z.boolean(), path: nonempty, include_redacted_action: z.boolean() });
const rules = z.strictObject({ block: z.array(rule), ask: z.array(rule), allow: z.array(rule) });
const schema = z.strictObject({
  version: z.literal(1), mode: z.enum(["shadow", "enforce", "disabled"]),
  load_project_config: z.boolean(), unmatched: handling, rules, classifier, approval, audit,
});
const layerSchema = schema.partial().extend({
  rules: rules.partial().optional(), approval: approval.partial().optional(), audit: audit.partial().optional(),
  classifier: classifier.partial().extend({ input: input.partial().optional() }).optional(),
});
export type Config = z.infer<typeof schema>;
export type Rule = z.infer<typeof rule>;
export interface ConfigState { config: Config; active: boolean; files: string[]; errors: string[] }

export const defaults: Config = {
  version: 1, mode: "shadow", load_project_config: true, unmatched: "allow",
  rules: { block: [], ask: [], allow: [] },
  classifier: {
    enabled: true, model: "jev-1.13.0", timeout_ms: 1500, on_error: "allow", approve_probability_min: 0.8,
    instructions: "Routine edits, overwrites, source-file deletion, tests, builds, and dependency installation are acceptable. Ask before likely major irreversible loss, especially production database deletion, destruction of important external resources, or broad deletion of personal data. An unfamiliar command alone is not a reason to ask; missing context is not proof of safety.",
    input: { include_user_context: true, max_user_context_chars: 8000, max_action_chars: 12000 },
  },
  approval: { non_interactive: "allow", max_pending_prompts: 20 },
  audit: { enabled: true, path: "~/.pi/agent/logs/pi-auto-approve.jsonl", include_redacted_action: false },
};

export function mergeConfig(base: Config, raw: unknown, project = false): Config {
  const layer = layerSchema.parse(raw);
  if (project && layer.load_project_config !== undefined) throw new Error("load_project_config is user-only");
  const merged = schema.parse({
    ...base, ...layer,
    rules: { ...base.rules, ...layer.rules },
    approval: { ...base.approval, ...layer.approval },
    audit: { ...base.audit, ...layer.audit },
    classifier: { ...base.classifier, ...layer.classifier, input: { ...base.classifier.input, ...layer.classifier?.input } },
  });
  const ids = Object.values(merged.rules).flat().map(r => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("Rule IDs must be unique");
  return merged;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function loadConfig(cwd: string, agentDir = join(homedir(), ".pi/agent"), projectTrusted = true): Promise<ConfigState> {
  let config = structuredClone(defaults);
  const files: string[] = [];
  const errors: string[] = [];
  async function load(path: string, project: boolean): Promise<void> {
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`${path}: could not read configuration`);
    }
    files.push(path);
    try {
      const document = parseDocument(text);
      if (document.errors.length) throw new Error("Invalid YAML");
      config = mergeConfig(config, document.toJS({ maxAliasCount: 50 }), project);
    } catch (error) {
      // Do not include YAML values (which might contain credentials) in diagnostics.
      const message = error instanceof z.ZodError
        ? error.issues.map(i => `${i.path.join(".") || "configuration"}: ${i.code}`).join("; ")
        : error instanceof Error && ["load_project_config is user-only", "Rule IDs must be unique"].includes(error.message)
          ? error.message : "Invalid configuration";
      throw new Error(`${path}: ${message}`);
    }
  }
  try {
    await load(join(agentDir, "pi-auto-approve.yaml"), false);
    if (projectTrusted && config.load_project_config) await load(resolve(cwd, ".pi/auto-approve.yaml"), true);
  } catch (error) {
    errors.push((error as Error).message);
    return { config: structuredClone(defaults), active: false, files, errors };
  }
  config.audit.path = resolve(cwd, expandHome(config.audit.path));
  return { config, active: true, files, errors };
}
