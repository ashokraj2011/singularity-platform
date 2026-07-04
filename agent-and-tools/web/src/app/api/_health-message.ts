function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function primitiveText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function fallbackHealthMessage(statusText: string, ok: boolean): string {
  return statusText || (ok ? "Healthy" : "Unhealthy");
}

function compactRecordSummary(record: Record<string, unknown>, maxText: number): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const text = primitiveText(value);
    if (text) parts.push(`${key}: ${text}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join("; ").slice(0, maxText) : null;
}

function healthCheckMessage(record: Record<string, unknown>, maxText: number): string | null {
  const data = asRecord(record.data) ?? record;
  const checks = Array.isArray(data.checks) ? data.checks.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  if (checks.length === 0) return null;

  const failed = checks.filter((check) => check.ok !== true);
  if (failed.length === 0) return `All ${checks.length} strict health check${checks.length === 1 ? "" : "s"} passed`.slice(0, maxText);

  const parts = failed.slice(0, 3).map((check) => {
    const name = primitiveText(check.name) ?? "unknown";
    const reason = primitiveText(check.reason);
    return reason ? `${name}: ${reason}` : name;
  });
  const suffix = failed.length > parts.length ? `; +${failed.length - parts.length} more` : "";
  return `failed checks: ${parts.join("; ")}${suffix}`.slice(0, maxText);
}

function jsonHealthMessage(value: unknown, statusText: string, ok: boolean, maxText: number): string | null {
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`.slice(0, maxText);
    return primitiveText(value)?.slice(0, maxText) ?? null;
  }

  const checkMessage = healthCheckMessage(record, maxText);
  if (checkMessage) return checkMessage;

  for (const key of ["message", "error", "detail", "title", "reason"]) {
    const text = primitiveText(record[key]);
    if (text) return text.slice(0, maxText);
  }

  const connected = Array.isArray(record.connected) ? record.connected.length : primitiveText(record.connected);
  const count = primitiveText(record.count);
  const status = primitiveText(record.status);
  if (status && connected != null) return `status: ${status}; connected: ${connected}`.slice(0, maxText);
  if (status && count != null) return `status: ${status}; count: ${count}`.slice(0, maxText);
  if (status) return `status: ${status}`.slice(0, maxText);

  const healthy = typeof record.ok === "boolean" ? record.ok : undefined;
  if (healthy != null) return healthy ? "Healthy" : "Unhealthy";

  return compactRecordSummary(record, maxText) ?? fallbackHealthMessage(statusText, ok);
}

export function healthProbeMessage(raw: string, statusText: string, ok: boolean, maxText = 260): string {
  const text = raw.trim();
  if (!text) return fallbackHealthMessage(statusText, ok).slice(0, maxText);
  try {
    return (jsonHealthMessage(JSON.parse(text) as unknown, statusText, ok, maxText) ?? fallbackHealthMessage(statusText, ok)).slice(0, maxText);
  } catch {
    return text.slice(0, maxText);
  }
}
