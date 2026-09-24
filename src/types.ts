export const supportedTools = ["bash", "read", "write", "edit", "find", "grep", "ls"] as const;
export type Mode = "shadow" | "enforce" | "disabled";
export type Handling = "allow" | "ask" | "block";
export interface Action {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  sessionId?: string;
  userContext?: string;
  contextTruncated?: boolean;
}
export interface Decision {
  recommendation: "approve" | "ask" | "block";
  source: "rule" | "jev" | "fallback";
  reason: string;
  ruleIds?: string[];
  classifier?: { model: string; approveProbability: number; latencyMs: number };
  /** Model the classifier call actually requested (after gateway mapping); differs from classifier.model on drift. */
  requestedModel?: string;
  errorCategory?: string;
}
export interface ClassificationInput {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  userContext?: string;
  contextTruncated: boolean;
  informationOmitted: boolean;
  instructions: string;
  model: string;
}
export interface ApprovalClassifier {
  classify(input: ClassificationInput, signal?: AbortSignal): Promise<{
    recommendation: "approve" | "ask";
    approveProbability: number;
    model: string;
    requestedModel: string;
    latencyMs: number;
  }>;
}
export type UserChoice = "allow_once" | "reject";
export interface ApprovalProvider {
  request(action: Action, decision: Decision, signal?: AbortSignal): Promise<UserChoice>;
}
