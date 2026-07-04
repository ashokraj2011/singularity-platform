export type Row = Record<string, unknown>;

export function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function asRow(value: unknown): Row {
  return isRecord(value) ? value : {};
}

export function asRowArray(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function asStringArray(value: unknown, maxItems = 80, maxLength = 160): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item).slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asDateTime(value: unknown, fallback = "-"): string {
  const text = asString(value);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}
