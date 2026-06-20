import dns from "dns/promises";
import net from "net";

export type AgentSourceUrlPolicy = {
  allowPrivateUrls?: boolean;
  resolveDns?: boolean;
};

const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "169.254.169.254",
]);

function normalizedHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4PrivateOrReserved(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  );
}

function ipv6PrivateOrReserved(address: string): boolean {
  const value = address.toLowerCase();
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8")
  );
}

function privateOrReservedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return ipv4PrivateOrReserved(address);
  if (family === 6) return ipv6PrivateOrReserved(address);
  return true;
}

function privateOrReservedHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  const ipFamily = net.isIP(host);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    METADATA_HOSTNAMES.has(host) ||
    (ipFamily !== 0 && privateOrReservedAddress(host))
  );
}

export async function assertAgentSourceUrlAllowed(
  rawUrl: string,
  policy: AgentSourceUrlPolicy = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("agent source URL must be absolute");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("agent source URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("agent source URL must not include embedded credentials");
  }

  if (policy.allowPrivateUrls) return parsed;

  if (privateOrReservedHostname(parsed.hostname)) {
    throw new Error("agent source URL targets a private, local, or metadata host");
  }

  if (policy.resolveDns === false) return parsed;

  const host = normalizedHostname(parsed.hostname);
  if (net.isIP(host)) return parsed;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("agent source URL host could not be resolved");
  }
  if (addresses.length === 0) throw new Error("agent source URL host could not be resolved");
  if (addresses.some((entry) => privateOrReservedAddress(entry.address))) {
    throw new Error("agent source URL resolves to a private, local, or metadata address");
  }

  return parsed;
}
