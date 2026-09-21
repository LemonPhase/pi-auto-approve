import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { Action } from "./types.js";
import type { Config } from "./config.js";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 [REDACTED]")
    .replace(/\b([\w-]*(?:token|password|passwd|secret|api[_-]?key|credential)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:password|token|secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?'"#]+)\?[^\s'"#]+/gi, "$1?[REDACTED]");
}

/** Never copy native write/edit bodies into summaries, even when logging is enabled. */
export function actionSummary(action: Action): Record<string, unknown> {
  const keys = action.tool === "bash" ? ["command", "timeout"] : ["path", "pattern", "glob", "offset", "limit"];
  return Object.fromEntries(keys.filter(key => action.args[key] !== undefined).map(key => [key,
    typeof action.args[key] === "string" ? redact(action.args[key] as string) : action.args[key],
  ]));
}

export type AuditRecord = Record<string, unknown> & { toolCallId: string; outcome: string };
export class AuditLog {
  readonly recent: AuditRecord[] = [];
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly warn: (message: string) => void) {}

  async write(config: Config, record: AuditRecord): Promise<void> {
    if (!config.audit.enabled) return;
    const entry = { schemaVersion: 1, timestamp: new Date().toISOString(), ...record };
    this.recent.push(entry);
    if (this.recent.length > 100) this.recent.shift();
    // The file follows include_redacted_action; the in-memory ring always keeps the
    // redacted summary so /guard-last can show what ran.
    const persisting = config.audit.include_redacted_action ? entry
      : Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "action"));
    const operation = this.tail.then(async () => {
      await mkdir(dirname(config.audit.path), { recursive: true, mode: 0o700 });
      const file = await open(config.audit.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(persisting)}\n`);
      } finally { await file.close(); }
    });
    this.tail = operation.catch(() => { this.warn("Audit logging failed; normal handling continues."); });
    await this.tail;
  }
}

const OUTCOME_LABEL: Record<string, string> = {
  executed: "ran", execution_started: "ran", approved: "allowed", rejected: "rejected",
  blocked: "blocked", approval_requested: "awaiting user", evaluated: "evaluated",
  cancelled: "cancelled", failed: "failed",
};

function displayTarget(summary: Record<string, unknown>): string {
  const target = typeof summary.command === "string" ? summary.command
    : typeof summary.path === "string"
      ? `${summary.path}${summary.contentCharacters === undefined ? "" : ` (${summary.contentCharacters} chars)`}`
      : JSON.stringify(summary);
  return target.length > 120 ? `${target.slice(0, 119)}…` : target;
}

/** One human-readable line per tool call; later records for a call win. */
export function renderRecords(records: AuditRecord[]): string {
  const byCall = new Map<string, AuditRecord>();
  for (const record of records) {
    const previous = byCall.get(record.toolCallId);
    byCall.set(record.toolCallId, previous ? { ...previous, ...record } : record);
  }
  const lines = [...byCall.values()].map(record => {
    const detail = record.errorCategory ? `fallback (${record.errorCategory})`
      : record.source === "jev" && record.classifier ? `jev p=${Number((record.classifier as { approveProbability: number }).approveProbability).toFixed(2)}`
      : record.source === "rule" && Array.isArray(record.ruleIds) && record.ruleIds.length ? `rule ${record.ruleIds.join(",")}`
      : typeof record.source === "string" ? record.source : "?";
    const summary = record.action as Record<string, unknown> | undefined;
    const mode = record.mode === "shadow" ? " (shadow)" : "";
    const columns = [typeof record.timestamp === "string" ? record.timestamp.slice(11, 19) : "?",
      String(record.tool), String(record.proposedDecision), detail,
      (OUTCOME_LABEL[record.outcome] ?? record.outcome) + mode];
    const widths = [8, 6, 7, 18, 12];
    const target = summary ? displayTarget(summary) : "(details not recorded)";
    return columns.map((column, index) => column.padEnd(widths[index])).join(" ") + target;
  });
  return lines.length ? lines.join("\n") : "No calls evaluated yet.";
}
