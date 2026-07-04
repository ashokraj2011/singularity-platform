import { serverEnv } from "./serverRootEnv";

export function boundedSecondsEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = serverEnv(name);
  if (!raw || raw.trim() === "") return defaultValue;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min) return defaultValue;
  return Math.min(max, Math.trunc(value));
}
