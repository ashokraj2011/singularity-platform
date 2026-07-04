/**
 * M36.4 — Shared client for the prompt-composer SystemPrompt store.
 *
 * Every service that needs a single-shot LLM prompt (event-horizon,
 * distillation, summarisation, capsule compiler, audit-gov diagnose)
 * imports this client instead of hardcoding the prompt string.
 *
 * Behavior:
 *   - In-memory cache, TTL configurable (default 300s)
 *   - One concurrent fetch per key (no thundering herd)
 *   - On composer outage, returns the most recent cached value (stale-ok)
 *   - Throws if the key is never seen and composer is unreachable
 *
 * Config (env, read at first call):
 *   PROMPT_COMPOSER_URL          required — http://prompt-composer:3004
 *   SYSTEM_PROMPT_CACHE_TTL_SEC  optional — default 300
 */

export interface SystemPromptResult {
  key: string;
  version: number;
  content: string;
  jsonSchema: unknown | null;
  modelHint: string | null;
}

interface CacheEntry {
  fetchedAt: number;
  value: SystemPromptResult;
}

interface InflightEntry {
  promise: Promise<SystemPromptResult>;
}

type SystemPromptEnvelope = {
  success?: boolean;
  data?: unknown;
  error?: unknown;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, InflightEntry>();

const SYSTEM_PROMPT_DEFAULT_TTL_SEC = 300;
const SYSTEM_PROMPT_MAX_TTL_SEC = 24 * 60 * 60;

function boundedTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return SYSTEM_PROMPT_DEFAULT_TTL_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return SYSTEM_PROMPT_DEFAULT_TTL_SEC;
  return Math.min(SYSTEM_PROMPT_MAX_TTL_SEC, Math.trunc(parsed));
}

function ttlMs(): number {
  return boundedTtlSeconds(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC) * 1000;
}

function composerUrl(): string {
  const v = process.env.PROMPT_COMPOSER_URL?.trim();
  if (!v) {
    throw new Error(
      "PROMPT_COMPOSER_URL is not set. SystemPrompt fetch requires the composer URL — " +
        "set PROMPT_COMPOSER_URL=http://prompt-composer:3004 in container env.",
    );
  }
  return v.replace(/\/$/, "");
}

async function fetchOnce(key: string, vars?: Record<string, unknown>): Promise<SystemPromptResult> {
  const url = vars
    ? `${composerUrl()}/api/v1/system-prompts/${encodeURIComponent(key)}/render`
    : `${composerUrl()}/api/v1/system-prompts/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: vars ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: vars ? JSON.stringify({ vars }) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `SystemPrompt fetch ${key} → ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  const json = parseSystemPromptEnvelope(await readResponseText(res), key);
  if (!json.success) {
    throw new Error(`SystemPrompt fetch ${key} returned success=false`);
  }
  return normalizeSystemPromptResult(json.data, key);
}

/**
 * Resolve a SystemPrompt by stable key.
 *
 *   const { content } = await getSystemPrompt("event-horizon.system")
 *
 * Optional `vars` performs Mustache substitution on the composer side
 * (uses POST /render); omit `vars` for a plain GET (faster, cached).
 *
 * Cache key includes vars, so plain GET and rendered POST don't collide.
 */
export async function getSystemPrompt(
  key: string,
  vars?: Record<string, unknown>,
): Promise<SystemPromptResult> {
  const cacheKey = vars ? `${key}::${stableHash(vars)}` : key;

  // Cache hit (fresh)
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < ttlMs()) {
    return hit.value;
  }

  // De-duplicate concurrent fetches for the same key
  const existing = inflight.get(cacheKey);
  if (existing) return existing.promise;

  const promise = (async () => {
    try {
      const value = await fetchOnce(key, vars);
      cache.set(cacheKey, { fetchedAt: Date.now(), value });
      return value;
    } catch (err) {
      // Stale-ok: if we have any prior value, return it rather than failing
      // the calling service. The caller still gets the error path on cold
      // start when composer is unreachable.
      if (hit) {
        return hit.value;
      }
      throw err;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, { promise });
  return promise;
}

/** Test/operator helper — clear the in-memory cache for a key (or all keys). */
export function invalidateSystemPromptCache(key?: string): void {
  if (key) {
    for (const k of Array.from(cache.keys())) {
      if (k === key || k.startsWith(`${key}::`)) cache.delete(k);
    }
  } else {
    cache.clear();
  }
}

function stableHash(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

async function readResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function responseSnippet(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function parseSystemPromptEnvelope(text: string, key: string): SystemPromptEnvelope {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response was not a JSON object");
    }
    return parsed as SystemPromptEnvelope;
  } catch (err) {
    const detail = err instanceof SyntaxError
      ? `${responseSnippet(text) || err.message}`
      : (err as Error).message;
    throw new Error(`SystemPrompt fetch ${key} returned invalid JSON: ${detail}`);
  }
}

function normalizeSystemPromptResult(data: unknown, key: string): SystemPromptResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`SystemPrompt fetch ${key} returned invalid data`);
  }
  const row = data as Partial<SystemPromptResult>;
  if (typeof row.key !== "string" || typeof row.content !== "string" || typeof row.version !== "number") {
    throw new Error(`SystemPrompt fetch ${key} returned incomplete data`);
  }
  return {
    key: row.key,
    version: row.version,
    content: row.content,
    jsonSchema: row.jsonSchema ?? null,
    modelHint: typeof row.modelHint === "string" ? row.modelHint : null,
  };
}
