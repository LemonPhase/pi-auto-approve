import type { ConfigState } from "./config.js";
import type { Action, ApprovalClassifier, ApprovalProvider, Mode } from "./types.js";
import { evaluate } from "./policy.js";
import { ApprovalQueue } from "./approval.js";
import { AuditLog, actionSummary, hash } from "./audit.js";
import { checkCancelled } from "./cancellation.js";

export class GuardBlocked extends Error {}

export class Guard {
  readonly queue = new ApprovalQueue();
  lastReportedModel: string | undefined;
  constructor(readonly audit: AuditLog, private readonly warn: (message: string) => void, private readonly classifier?: ApprovalClassifier) {}

  async execute<T>(action: Action, state: ConfigState, mode: Mode | undefined, provider: ApprovalProvider | undefined,
    signal: AbortSignal | undefined, delegate: () => Promise<T>): Promise<T> {
    // Capture snapshots before awaiting classification or an approval.
    const config = structuredClone(state.config);
    config.mode = mode ?? config.mode;
    checkCancelled(signal);
    if (!state.active || config.mode === "disabled") return delegate();
    const base = {
      sessionId: action.sessionId, toolCallId: action.id, tool: action.tool,
      actionHash: hash({ tool: action.tool, args: action.args, cwd: action.cwd }),
      mode: config.mode, configFingerprint: hash(config),
      // Always recorded in memory (redacted); the file copy drops it unless opted in.
      action: actionSummary(action),
    };
    let outcome = "failed";
    try {
      const decision = await evaluate(action, config, this.classifier, signal);
      if (decision.errorCategory) this.warn(decision.reason);
      if (decision.classifier) {
        this.lastReportedModel = decision.classifier.model;
        // Provider-side model swaps change behavior validated by evals; surface them once via the deduped warn path.
        if (decision.requestedModel && decision.requestedModel !== decision.classifier.model)
          this.warn(`Classifier model drift: requested ${decision.requestedModel}, response reported ${decision.classifier.model}.`);
      }
      // Omit free-text rule reasons from logs; they can contain arbitrary private data.
      const detail = { source: decision.source, proposedDecision: decision.recommendation, ruleIds: decision.ruleIds,
        classifier: decision.classifier, errorCategory: decision.errorCategory };
      await this.audit.write(config, { ...base, ...detail, outcome: "evaluated" });
      let execute = config.mode === "shadow" || decision.recommendation === "approve";
      let handling = config.mode === "shadow" ? "shadow" : decision.source;
      if (config.mode === "enforce" && decision.recommendation === "ask") {
        if (provider) {
          await this.audit.write(config, { ...base, ...detail, outcome: "approval_requested" });
          try {
            const choice = await this.queue.request(provider, action, decision, config.approval.max_pending_prompts, signal);
            execute = choice === "allow_once";
            handling = "user";
            outcome = execute ? "approved" : "rejected";
            await this.audit.write(config, { ...base, ...detail, outcome, userChoice: choice });
          } catch {
            checkCancelled(signal);
            execute = config.approval.non_interactive === "allow";
            handling = "non_interactive";
            this.warn("Approval unavailable; using configured non-interactive handling.");
          }
        } else {
          execute = config.approval.non_interactive === "allow";
          handling = "non_interactive";
        }
      }
      checkCancelled(signal);
      if (!execute) {
        outcome = outcome === "rejected" ? outcome : "blocked";
        await this.audit.write(config, { ...base, ...detail, outcome, handling });
        throw new GuardBlocked(`Pi Auto Approve: ${outcome}. ${decision.reason}`);
      }
      await this.audit.write(config, { ...base, ...detail, outcome: "execution_started", handling });
      checkCancelled(signal);
      const result = await delegate();
      await this.audit.write(config, { ...base, ...detail, outcome: "executed", handling });
      return result;
    } catch (error) {
      if (!(error instanceof GuardBlocked)) await this.audit.write(config, { ...base, outcome: signal?.aborted ? "cancelled" : "failed" });
      throw error;
    }
  }
}
