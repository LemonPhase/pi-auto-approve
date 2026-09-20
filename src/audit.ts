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
    const operation = this.tail.then(async () => {
      await mkdir(dirname(config.audit.path), { recursive: true, mode: 0o700 });
      const file = await open(config.audit.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(entry)}\n`);
      } finally { await file.close(); }
    });
    this.tail = operation.catch(() => { this.warn("Audit logging failed; normal handling continues."); });
    await this.tail;
  }
}
