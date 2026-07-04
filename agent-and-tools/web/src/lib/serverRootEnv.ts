import fs from "node:fs";
import path from "node:path";

let cachedRootEnv: Record<string, string> | null = null;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandSimpleRefs(value: string, env: Record<string, string>): string {
  return value.replace(/\$([A-Z0-9_]+)/g, (_match, key: string) => env[key] ?? process.env[key] ?? "");
}

function parseShellEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    env[key] = expandSimpleRefs(stripQuotes(normalized.slice(eq + 1)), env);
  }
  return env;
}

function loadRootEnv(): Record<string, string> {
  if (cachedRootEnv) return cachedRootEnv;
  const candidates = [
    path.resolve(process.cwd(), "../../.env.local"),
    path.resolve(process.cwd(), "../.env.local"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      cachedRootEnv = parseShellEnv(fs.readFileSync(candidate, "utf8"));
      return cachedRootEnv;
    } catch {
      // Diagnostics should remain available even if the fallback file cannot
      // be read. In that case process.env stays the source of truth.
    }
  }
  cachedRootEnv = {};
  return cachedRootEnv;
}

export function serverEnv(key: string, fallback?: string): string | undefined {
  const direct = process.env[key];
  if (direct !== undefined && direct !== "") return direct;
  const fromRoot = loadRootEnv()[key];
  if (fromRoot !== undefined && fromRoot !== "") return fromRoot;
  return fallback;
}
