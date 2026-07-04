function finiteNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function boundedNumberEnv(name: string, defaultValue: number, min: number, max: number): number {
  const value = finiteNumber(process.env[name]);
  if (value === null) return defaultValue;
  if (value < min) return defaultValue;
  if (value > max) return max;
  return value;
}

export function boundedIntEnv(name: string, defaultValue: number, min: number, max: number): number {
  return Math.trunc(boundedNumberEnv(name, defaultValue, min, max));
}

export function capsuleGcConfig() {
  return {
    maxCompileConcurrency: boundedIntEnv("CAPSULE_COMPILE_MAX_CONCURRENCY", 5, 1, 100),
    ttlDays: boundedIntEnv("CAPSULE_TTL_DAYS", 30, 1, 365),
    coldDays: boundedIntEnv("CAPSULE_COLD_DAYS", 30, 1, 365),
    gcIntervalMs: boundedIntEnv("CAPSULE_GC_INTERVAL_MS", 15 * 60_000, 60_000, 24 * 60 * 60_000),
    maxCapsuleChars: boundedIntEnv("CAPSULE_MAX_CHARS", 200_000, 1_000, 2_000_000),
    failureWindowMs: boundedIntEnv("CAPSULE_FAILURE_WINDOW_MS", 60 * 60_000, 60_000, 24 * 60 * 60_000),
    failureAlertThreshold: boundedNumberEnv("CAPSULE_FAILURE_ALERT_RATE", 0.05, 0, 1),
    failureAlertIntervalMs: boundedIntEnv("CAPSULE_FAILURE_ALERT_INTERVAL_MS", 60_000, 30_000, 24 * 60 * 60_000),
    failureAlertMinAttempts: boundedIntEnv("CAPSULE_FAILURE_ALERT_MIN_ATTEMPTS", 20, 1, 10_000),
    retryDelayMs: boundedIntEnv("CAPSULE_RETRY_DELAY_MS", 30_000, 1_000, 60 * 60_000),
  };
}
