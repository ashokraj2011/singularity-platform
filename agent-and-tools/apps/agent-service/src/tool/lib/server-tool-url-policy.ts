export type ServerToolUrlDecision =
  | { allowed: true; normalizedUrl: string; matchedRule: string }
  | { allowed: false; reason: string };

const DEFAULT_ALLOWLIST = [
  "http://agent-service:3001/api/v1/internal-tools",
  "http://agent-service:3001/api/v1/connector-tools",
  "http://localhost:3001/api/v1/internal-tools",
  "http://localhost:3001/api/v1/connector-tools",
  "http://127.0.0.1:3001/api/v1/internal-tools",
  "http://127.0.0.1:3001/api/v1/connector-tools",
];

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "host.docker.internal",
  "gateway.docker.internal",
]);

const INTERNAL_TOOL_PREFIXES = [
  "/api/v1/internal-tools",
  "/api/v1/connector-tools",
];

function parseAllowlist(raw?: string): string[] {
  return (raw?.trim() ? raw : DEFAULT_ALLOWLIST.join(","))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePathPrefix(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function matchesUrlPrefix(target: URL, rule: string): boolean {
  let allowed: URL;
  try {
    allowed = new URL(rule);
  } catch {
    return false;
  }

  if (target.origin !== allowed.origin) return false;

  const prefix = normalizePathPrefix(allowed.pathname);
  const path = normalizePathPrefix(target.pathname);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isInternalToolServiceEndpoint(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  const trustedHost = (
    (host === "agent-service" && target.port === "3001") ||
    ((host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") && target.port === "3001")
  );
  if (!trustedHost) return false;
  const path = normalizePathPrefix(target.pathname);
  return INTERNAL_TOOL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isPrivateOrLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function serverToolUrlPolicy(endpointUrl: unknown, allowlistRaw = process.env.TOOL_SERVER_ENDPOINT_ALLOWLIST): ServerToolUrlDecision {
  if (typeof endpointUrl !== "string" || !endpointUrl.trim()) {
    return { allowed: false, reason: "server tool endpoint_url is required" };
  }

  let target: URL;
  try {
    target = new URL(endpointUrl.trim());
  } catch {
    return { allowed: false, reason: "server tool endpoint_url must be an absolute URL" };
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { allowed: false, reason: "server tool endpoint_url must use http or https" };
  }
  if (target.username || target.password) {
    return { allowed: false, reason: "server tool endpoint_url cannot include credentials" };
  }
  if (BLOCKED_HOSTS.has(target.hostname.toLowerCase())) {
    return { allowed: false, reason: "server tool endpoint_url cannot target metadata hosts" };
  }
  if (isPrivateOrLocalhost(target.hostname) && !isInternalToolServiceEndpoint(target)) {
    return { allowed: false, reason: "server tool endpoint_url cannot target private or loopback hosts outside internal agent-service endpoints" };
  }

  for (const rule of parseAllowlist(allowlistRaw)) {
    if (matchesUrlPrefix(target, rule)) {
      return { allowed: true, normalizedUrl: target.toString(), matchedRule: rule };
    }
  }

  return {
    allowed: false,
    reason: "server tool endpoint_url is not in TOOL_SERVER_ENDPOINT_ALLOWLIST",
  };
}
