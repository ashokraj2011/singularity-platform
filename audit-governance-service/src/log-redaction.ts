const SECRET_KEY_RE = /(?:^|[_-])(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const SAFE_SECRET_METADATA_RE = /(?:count|length|len|present|configured|enabled|env|name|source|class|type|status)$/i;

export function redactLogText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(ghp|github_pat|glpat|sk-ant|sk-proj|sk)[A-Za-z0-9_:-]{12,}/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, "$1[REDACTED]$2")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|client[_-]?secret)\b(\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, "$1$2$3[REDACTED]");
}

function isSecretField(key: string): boolean {
  return SECRET_KEY_RE.test(key) && !SAFE_SECRET_METADATA_RE.test(key);
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactLogText(value).slice(0, 16_000);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactLogValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([key, item]) => [
    key,
    isSecretField(key) ? "[REDACTED]" : redactLogValue(item, depth + 1),
  ]));
}
