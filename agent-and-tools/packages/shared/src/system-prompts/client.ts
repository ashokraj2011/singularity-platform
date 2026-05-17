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

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, InflightEntry>();

function ttlMs(): number {
  const raw = process.env.SYSTEM_PROMPT_CACHE_TTL_SEC;
  const n = raw ? Number(raw) : 300;
  return Math.max(1, n) * 1000;
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
  const json = (await res.json()) as { success: boolean; data: SystemPromptResult; error?: unknown };
  if (!json.success) {
    throw new Error(`SystemPrompt fetch ${key} returned success=false`);
  }
  return json.data;
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
