import type { Config, Rule } from "./config.js";
import type { Action, ApprovalClassifier, ClassificationInput, Decision, Handling } from "./types.js";
import { actionSummary, redact } from "./audit.js";
import { cancellable, checkCancelled } from "./cancellation.js";

export function fallback(handling: Handling, reason: string, errorCategory?: string): Decision {
  return { recommendation: handling === "allow" ? "approve" : handling, source: "fallback", reason, errorCategory };
}
export function matches(rule: Rule, action: Action): boolean {
  if (rule.tool !== action.tool) return false;
  if (rule.command_exact !== undefined) return action.args.command === rule.command_exact;
  if (rule.command_contains !== undefined) return typeof action.args.command === "string" && action.args.command.includes(rule.command_contains);
  if (rule.path_exact !== undefined) return action.args.path === rule.path_exact;
  return true;
}

export function classificationInput(action: Action, config: Config): ClassificationInput {
  const args = actionSummary(action);
  let informationOmitted = Object.keys(action.args).some(key => !(key in args));
  if (typeof action.args.content === "string") args.contentCharacters = action.args.content.length;
  if (Array.isArray(action.args.edits)) args.editCount = action.args.edits.length;
  if (JSON.stringify(args) !== JSON.stringify(action.args)) informationOmitted = true;
  const context = config.classifier.input.include_user_context ? action.userContext : undefined;
  const limit = config.classifier.input.max_user_context_chars;
  const input = {
    tool: action.tool, args, cwd: redact(action.cwd),
    userContext: context === undefined ? undefined : redact(context.slice(-limit)),
    contextTruncated: !!action.contextTruncated || (context?.length ?? 0) > limit,
    informationOmitted, instructions: config.classifier.instructions, model: config.classifier.model,
  };
  if (JSON.stringify({ tool: input.tool, args, cwd: input.cwd }).length > config.classifier.input.max_action_chars)
    throw new Error("input_limit");
  return input;
}

export async function evaluate(action: Action, config: Config, classifier?: ApprovalClassifier, signal?: AbortSignal): Promise<Decision> {
  checkCancelled(signal);
  for (const kind of ["block", "ask", "allow"] as const) {
    const rules = config.rules[kind].filter(rule => matches(rule, action));
    if (rules.length) return {
      recommendation: kind === "allow" ? "approve" : kind, source: "rule",
      reason: rules.map(rule => rule.reason).join("; "), ruleIds: rules.map(rule => rule.id),
    };
  }
  if (!config.classifier.enabled) return fallback(config.unmatched, "Classifier disabled; using unmatched setting.");
  if (!classifier) return fallback(config.classifier.on_error, "Jev integration is not available in Milestone 1.", "classifier_unavailable");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const input = classificationInput(action, config);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.classifier.timeout_ms);
    const result = await cancellable(classifier.classify(input, combined), combined);
    checkCancelled(signal);
    if (!["approve", "ask"].includes(result.recommendation) || !Number.isFinite(result.approveProbability)
      || result.approveProbability < 0 || result.approveProbability > 1 || !result.model
      || !Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new Error("invalid_response");
    const recommendation = result.recommendation === "approve" && result.approveProbability >= config.classifier.approve_probability_min ? "approve" : "ask";
    return { recommendation, source: "jev", reason: `Classifier recommended ${recommendation}.`, classifier: {
      model: result.model, approveProbability: result.approveProbability, latencyMs: result.latencyMs,
    } };
  } catch (error) {
    checkCancelled(signal);
    const code = timedOut ? "timeout" : error instanceof Error && ["input_limit", "invalid_response"].includes(error.message) ? error.message : "classifier_error";
    return fallback(config.classifier.on_error, `Classifier unavailable (${code}); using configured fallback.`, code);
  } finally { if (timer) clearTimeout(timer); }
}
