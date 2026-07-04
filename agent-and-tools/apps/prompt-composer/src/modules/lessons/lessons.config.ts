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
  const value = boundedNumberEnv(name, defaultValue, min, max);
  return Math.trunc(value);
}

export function boundedLessonTake(value: unknown, defaultValue = 3): number {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 1) return defaultValue;
  return Math.min(50, Math.trunc(parsed));
}

export function lessonConfig() {
  return {
    supersedeCosineThreshold: boundedNumberEnv("LESSON_SUPERSEDE_COSINE", 0.85, 0, 1),
    maxActivePerScope: boundedIntEnv("LESSON_MAX_ACTIVE_PER_SCOPE", 20, 1, 200),
    toolMatchBoost: boundedNumberEnv("LESSON_TOOL_MATCH_BOOST", 0.05, 0, 1),
    retrievalFloor: boundedNumberEnv("LESSON_RETRIEVAL_FLOOR", 0.3, 0, 1),
    defaultTopK: boundedIntEnv("LESSONS_TOPK", 3, 1, 50),
  };
}
