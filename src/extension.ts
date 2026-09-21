import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, defaults, type ConfigState } from "./config.js";
import { AuditLog } from "./audit.js";
import { Guard } from "./guard.js";
import type { Action, ApprovalClassifier, Mode } from "./types.js";
import { wrapTool } from "./tools.js";
import { createApprovalProvider } from "./approval-ui.js";

function userContext(ctx: ExtensionContext, max: number): { userContext: string; contextTruncated: boolean } {
  const texts: string[] = [];
  let size = 0;
  let truncated = false;
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (size + text.length + 2 > max) {
      const remaining = Math.max(0, max - size);
      if (remaining) texts.unshift(text.slice(-remaining));
      truncated = true;
      break;
    }
    texts.unshift(text);
    size += text.length + 2;
  }
  return { userContext: texts.join("\n\n").slice(-max), contextTruncated: truncated };
}

export function registerAutoApprove(pi: ExtensionAPI, classifier?: ApprovalClassifier): void {
  let state: ConfigState = { active: false, config: structuredClone(defaults), files: [], errors: [] };
  let mode: Mode | undefined;
  let context: ExtensionContext | undefined;
  let coverage: string[] = [];
  let skipped: string[] = [];
  const owners = new Map<string, string>();
  const warned = new Set<string>();
  function notify(message: string, warning = false): void {
    if (context?.hasUI) context.ui.notify(message, warning ? "warning" : "info");
    else process.stderr.write(`Pi Auto Approve: ${message}\n`);
  }
  function warn(message: string): void {
    if (!warned.has(message)) { warned.add(message); notify(message, true); }
  }
  const audit = new AuditLog(warn);
  const guard = new Guard(audit, warn, classifier);

  const status = () => JSON.stringify({
    active: state.active, mode: mode ?? state.config.mode, files: state.files, errors: state.errors,
    classifier: classifier ? "available" : "not configured",
    coverage, skipped, settings: { ...state.config, mode: mode ?? state.config.mode },
  }, null, 2);

  async function reload(ctx: ExtensionContext): Promise<void> {
    context = ctx;
    const loaded = await loadConfig(ctx.cwd, getAgentDir());
    state = loaded;
    mode = undefined;
    warned.clear();
    if (!state.active) warn(`${state.errors.join("; ")}. Approver inactive: actions run without approval checks.`);
    else {
      notify(`Mode: ${state.config.mode}; classifier error: ${state.config.classifier.on_error}; no UI: ${state.config.approval.non_interactive}.`);
      if (state.config.mode !== "disabled" && state.config.classifier.enabled) {
        if (!classifier) warn(`No classifier is configured; unmatched calls use classifier.on_error=${state.config.classifier.on_error}.`);
        else if (!process.env.TYPESAFE_API_KEY && !process.env.AI_GATEWAY_API_KEY)
          warn(`Neither TYPESAFE_API_KEY nor AI_GATEWAY_API_KEY is set; Jev calls use classifier.on_error=${state.config.classifier.on_error}.`);
      }
    }
  }

  function wrap<T extends ToolDefinition<any, any, any>>(delegate: T): T {
    return wrapTool(delegate, async ([id, args, signal, _onUpdate, ctx], next) => {
      context = ctx;
      const snapshot = state;
      const snapshotMode = mode;
      const input = args as Record<string, unknown>;
      const action: Action = {
        id, tool: delegate.name, args: input, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(),
        ...(snapshot.config.classifier.input.include_user_context ? userContext(ctx, snapshot.config.classifier.input.max_user_context_chars) : {}),
      };
      return guard.execute(action, snapshot, snapshotMode, ctx.hasUI ? createApprovalProvider(ctx.ui) : undefined, signal, next);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await reload(ctx);
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    const definitions: ToolDefinition<any, any, any>[] = [
      createBashToolDefinition(ctx.cwd, { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() }),
      createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize() }),
      createWriteToolDefinition(ctx.cwd), createEditToolDefinition(ctx.cwd), createFindToolDefinition(ctx.cwd),
      createGrepToolDefinition(ctx.cwd), createLsToolDefinition(ctx.cwd),
    ];
    const available = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    const active = pi.getActiveTools();
    // Pi's SDK base-tool substitutions are labelled builtin too, but lose prompt
    // metadata. Do not reconstruct their execution backends as local tools.
    const coreNames = new Set(["bash", "read", "write", "edit"]);
    const substitutedBase = definitions.some(definition => {
      const tool = available.get(definition.name);
      return coreNames.has(definition.name) && tool?.sourceInfo.source === "builtin"
        && JSON.stringify(tool.promptGuidelines) !== JSON.stringify(definition.promptGuidelines);
    });
    coverage = [];
    skipped = [];
    for (const definition of definitions) {
      const tool = available.get(definition.name);
      if (!tool) continue;
      if (substitutedBase) { skipped.push(definition.name); continue; }
      if (tool.sourceInfo.source !== "builtin" && tool.sourceInfo.path !== owners.get(definition.name)) { skipped.push(definition.name); continue; }
      pi.registerTool(wrap(definition));
      const registered = pi.getAllTools().find(item => item.name === definition.name);
      if (registered?.sourceInfo.source !== "builtin" && registered) owners.set(definition.name, registered.sourceInfo.path);
      coverage.push(definition.name);
    }
    pi.setActiveTools(active);
    if (skipped.length) warn(`Custom tools left unchanged and unguarded: ${skipped.join(", ")}.`);
  });

  pi.registerCommand("guard-status", { description: "Show approval settings, state, and tool coverage", handler: async (_args, ctx) => {
    context = ctx; notify(status());
  } });
  pi.registerCommand("guard-mode", { description: "Set shadow, enforce, or disabled for this session", handler: async (args, ctx) => {
    context = ctx;
    const value = args.trim();
    if (!["shadow", "enforce", "disabled"].includes(value)) { notify("Usage: /guard-mode shadow|enforce|disabled", true); return; }
    if (!state.active) { notify("Configuration is invalid. Fix it and run /guard-reload first.", true); return; }
    mode = value as Mode;
    notify(`Mode: ${mode}. Pending approvals keep their original settings.`);
  } });
  pi.registerCommand("guard-reload", { description: "Reload configuration and clear the session mode override", handler: async (_args, ctx) => { await reload(ctx); } });
  pi.registerCommand("guard-last", { description: "Show recent in-memory audit records (default 10, maximum 100)", handler: async (args, ctx) => {
    context = ctx;
    const count = args.trim() ? Number(args.trim()) : 10;
    if (!Number.isInteger(count) || count < 1 || count > 100) { notify("Usage: /guard-last [1..100]", true); return; }
    notify(JSON.stringify(audit.recent.slice(-count), null, 2));
  } });
}
