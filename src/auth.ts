import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type KeyKind = "direct" | "gateway";
export const AUTH_FILENAME = "pi-auto-approve-auth.json";

export function envFor(kind: KeyKind): string {
  return kind === "direct" ? "TYPESAFE_API_KEY" : "AI_GATEWAY_API_KEY";
}

export function authPath(agentDir: string): string {
  return join(agentDir, AUTH_FILENAME);
}

function parseFile(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const env of ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"]) {
      const value = (parsed as Record<string, unknown>)[env];
      if (typeof value === "string" && value.trim()) out[env] = value.trim();
    }
    return out;
  } catch { return {}; }
}

/** Load persisted keys into process.env without overwriting shell-provided values. */
export async function loadPersistedKeys(agentDir: string): Promise<void> {
  let raw: string;
  try { raw = await readFile(authPath(agentDir), "utf8"); }
  catch { return; }
  for (const [env, value] of Object.entries(parseFile(raw)))
    if (!process.env[env]) process.env[env] = value;
}

/** Save a key and activate it for this session (env is what the classifier reads). */
export async function persistKey(agentDir: string, kind: KeyKind, value: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  let current: Record<string, string> = {};
  try { current = parseFile(await readFile(authPath(agentDir), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  current[envFor(kind)] = value;
  process.env[envFor(kind)] = value;
  const path = authPath(agentDir);
  await writeFile(path, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Remove persisted keys and clear them from this session. */
export async function clearPersistedKeys(agentDir: string, kinds: KeyKind[]): Promise<void> {
  let current: Record<string, string> = {};
  try { current = parseFile(await readFile(authPath(agentDir), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  for (const kind of kinds) {
    delete current[envFor(kind)];
    delete process.env[envFor(kind)];
  }
  const path = authPath(agentDir);
  await writeFile(path, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Which credential the classifier will use, without exposing values. */
export function credentialSummary(): string {
  if (process.env.TYPESAFE_API_KEY) return "direct";
  if (process.env.AI_GATEWAY_API_KEY) return "gateway";
  return "none";
}
