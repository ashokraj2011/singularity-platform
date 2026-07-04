function finiteNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedIntEnv(name: string, defaultValue: number, min: number, max: number): number {
  const value = finiteNumber(process.env[name]);
  if (value === null) return defaultValue;
  if (value < min) return defaultValue;
  if (value > max) return max;
  return Math.trunc(value);
}

export function llmCapsuleCompilerConfig() {
  return {
    timeoutMs: boundedIntEnv("CAPSULE_COMPILE_TIMEOUT_MS", 30_000, 1_000, 5 * 60_000),
    systemPromptCacheTtlMs: boundedIntEnv("SYSTEM_PROMPT_CACHE_TTL_SEC", 300, 1, 24 * 60 * 60) * 1000,
    modelAlias: process.env.CAPSULE_COMPILE_MODEL_ALIAS?.trim() || undefined,
  };
}
