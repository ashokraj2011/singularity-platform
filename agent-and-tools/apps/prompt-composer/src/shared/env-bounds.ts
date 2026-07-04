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
