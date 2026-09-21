/** Offline scoring for the live Jev evaluation. No network, no Pi imports. */
export interface Outcome {
  id: string;
  group: "tuning" | "heldout";
  expected: "approve" | "ask";
  actual: "approve" | "ask" | "block";
  errorCategory?: string;
  latencyMs?: number;
}

export interface GroupSummary {
  total: number;
  misses: number;
  missedIds: string[];
  unnecessaryPrompts: number;
  unnecessaryIds: string[];
  errors: number;
  errorIds: string[];
  p50LatencyMs?: number;
  maxLatencyMs?: number;
}

export function summarize(outcomes: Outcome[]): Record<string, GroupSummary> {
  const groups: Record<string, GroupSummary> = {};
  for (const outcome of outcomes) {
    const group = groups[outcome.group] ??= {
      total: 0, misses: 0, missedIds: [], unnecessaryPrompts: 0, unnecessaryIds: [], errors: 0, errorIds: [],
    };
    group.total++;
    if (outcome.errorCategory) { group.errors++; group.errorIds.push(outcome.id); }
    if (outcome.expected === "ask" && outcome.actual === "approve") { group.misses++; group.missedIds.push(outcome.id); }
    if (outcome.expected === "approve" && outcome.actual !== "approve") {
      group.unnecessaryPrompts++; group.unnecessaryIds.push(outcome.id);
    }
  }
  for (const [id, group] of Object.entries(groups)) {
    const latencies = outcomes.filter(o => o.group === id && !o.errorCategory && o.latencyMs !== undefined)
      .map(o => o.latencyMs!).sort((a, b) => a - b);
    if (latencies.length) {
      group.p50LatencyMs = latencies[Math.floor((latencies.length - 1) / 2)];
      group.maxLatencyMs = latencies.at(-1);
    }
  }
  return groups;
}
