import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type KeyKind = "direct" | "gateway";
export const AUTH_FILENAME = "pi-auto-approve-auth.json";

type EnvName = "TYPESAFE_API_KEY" | "AI_GATEWAY_API_KEY";

/** In-memory key store. Keys live here and in the auth file, never in process.env. */
const store: Partial<Record<EnvName, string>> = {};

function envFor(kind: KeyKind): EnvName {
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

/**
 * Resolve the active credential per call: explicit key, then the in-memory
 * store, then process.env as a read-only fallback (for users who export their
 * own keys, e.g. in CI). We never write process.env.
 */
export function resolveKey(explicit?: string): { apiKey: string; kind: KeyKind } | undefined {
  if (explicit) return { apiKey: explicit, kind: "direct" };
  if (store.TYPESAFE_API_KEY) return { apiKey: store.TYPESAFE_API_KEY, kind: "direct" };
  if (store.AI_GATEWAY_API_KEY) return { apiKey: store.AI_GATEWAY_API_KEY, kind: "gateway" };
  if (process.env.TYPESAFE_API_KEY) return { apiKey: process.env.TYPESAFE_API_KEY, kind: "direct" };
  if (process.env.AI_GATEWAY_API_KEY) return { apiKey: process.env.AI_GATEWAY_API_KEY, kind: "gateway" };
  return undefined;
}

/** Load persisted keys into the in-memory store. */
export async function loadPersistedKeys(agentDir: string): Promise<void> {
  let raw: string;
  try { raw = await readFile(authPath(agentDir), "utf8"); }
  catch { return; }
  for (const [env, value] of Object.entries(parseFile(raw)))
    store[env as EnvName] = value;
}

/** Save a key to the auth file and activate it for this session. */
export async function persistKey(agentDir: string, kind: KeyKind, value: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  let current: Record<string, string> = {};
  try { current = parseFile(await readFile(authPath(agentDir), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  current[envFor(kind)] = value;
  store[envFor(kind)] = value;
  const path = authPath(agentDir);
  await writeFile(path, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Remove persisted keys from the auth file and the in-memory store. */
export async function clearPersistedKeys(agentDir: string, kinds: KeyKind[]): Promise<void> {
  let current: Record<string, string> = {};
  try { current = parseFile(await readFile(authPath(agentDir), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  for (const kind of kinds) {
    delete current[envFor(kind)];
    delete store[envFor(kind)];
  }
  const path = authPath(agentDir);
  await writeFile(path, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Which credential the classifier will use, without exposing values. */
export function credentialSummary(): string {
  return resolveKey()?.kind ?? "none";
}
