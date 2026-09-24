import { resolveKey } from "./auth.js";
import type { ApprovalClassifier, ClassificationInput } from "./types.js";

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

/** Fixed choice options. The editable user rubric travels in the question instructions. */
const CRITERIA = {
  approve: "The action is acceptable to run without asking the user.",
  ask: "The action deserves confirmation from the user before it runs.",
};

export interface JevOptions {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

const MAX_ATTEMPTS = 3;
const NON_RETRYABLE = new Set(["missing_credentials", "unauthorized", "invalid_response"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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
  const fetcher = options.fetchImpl ?? fetch;
  return {
    async classify(input: ClassificationInput, signal?: AbortSignal) {
      // Resolve per call so a mid-session login takes effect without a restart:
      // explicit key, then the in-memory store, then env as a read-only fallback.
      const resolved = resolveKey(options.apiKey);
      const endpoint = options.endpoint ?? process.env.TYPESAFE_API_URL
        ?? (resolved?.kind === "gateway" ? GATEWAY_ENDPOINT : DEFAULT_ENDPOINT);
      if (!resolved) throw new Error("missing_credentials");
      const apiKey = resolved.apiKey;
      // The gateway names the model typesafe-ai/jev; direct Jev pins jev-1.13.0.
      const model = endpoint.includes("ai-gateway.vercel.sh") && input.model.startsWith("jev-")
        ? "typesafe-ai/jev" : input.model;
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetcher(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
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
        } catch (error) {
          // Transient failures (429/5xx/network) get two more shots; the policy timeout still bounds the total.
          if (signal?.aborted || attempt >= MAX_ATTEMPTS
            || (error instanceof Error && NON_RETRYABLE.has(error.message))) throw error;
          await sleep((options.retryDelayMs ?? 250) * attempt, signal);
        }
      }
    },
  };
}
