import type { ApprovalClassifier, ClassificationInput } from "./types.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Fixed choice options. The editable user rubric travels in the question instructions. */
const CRITERIA = {
  approve: "The action is acceptable to run without asking the user.",
  ask: "The action deserves confirmation from the user before it runs.",
};

export interface JevOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Validate the typed answer. Anything malformed is an error, never a decision. */
function interpret(body: unknown, latencyMs: number): { recommendation: "approve" | "ask"; approveProbability: number; model: string; latencyMs: number } {
  const root = asRecord(body);
  const answer = asRecord(asRecord(root?.answers)?.decision);
  const probabilities = asRecord(answer?.probabilities);
  const model = root?.model;
  if (typeof model !== "string" || !model || answer?.type !== "choice" || !probabilities) throw new Error("invalid_response");
  for (const value of Object.values(probabilities))
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("invalid_response");
  const choice = answer.choice;
  if (choice !== "approve" && choice !== "ask") throw new Error("invalid_response");
  if (!(choice in probabilities)) throw new Error("invalid_response");
  const approveProbability = probabilities.approve;
  if (typeof approveProbability !== "number") throw new Error("invalid_response");
  return { recommendation: choice, approveProbability, model, latencyMs };
}

export function createJevClassifier(options: JevOptions = {}): ApprovalClassifier {
  const endpoint = options.endpoint ?? process.env.TYPESAFE_API_URL ?? DEFAULT_ENDPOINT;
  const fetcher = options.fetchImpl ?? fetch;
  return {
    async classify(input: ClassificationInput, signal?: AbortSignal) {
      const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error("missing_credentials");
      const started = Date.now();
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          state: {
            tool: input.tool, action: input.args, working_directory: input.cwd,
            task_context: input.userContext ?? null,
            context_truncated: input.contextTruncated, information_omitted: input.informationOmitted,
          },
          questions: { decision: { type: "choice", instructions: input.instructions, criteria: CRITERIA } },
        }),
        signal,
      });
      if (!response.ok)
        throw new Error(response.status === 401 || response.status === 403 ? "unauthorized"
          : response.status === 429 ? "rate_limited" : "provider_error");
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new Error("invalid_response"); }
      return interpret(body, Date.now() - started);
    },
  };
}
