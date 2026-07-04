export function sanitizeWorkgraphSurfaceText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, "[redacted-github-token]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .replace(/\b((?:authorization|access_token|api_key|apikey|token|secret|password)=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/\b((?:authorization|access_token|api_key|apikey|token|secret|password)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1[redacted]$2");
}
