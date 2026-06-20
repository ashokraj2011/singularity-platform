const PROD_ENVS = new Set(["production", "prod", "staging", "perf"]);
const DEV_ENVS = new Set(["development", "dev", "local", "test"]);
const KNOWN_DEV_DEFAULTS = new Set([
  "Admin1234!",
  "change-me-in-production",
  "change-me-now",
  "changeme",
  "changeme_dev_only_min_32_chars_long!!",
  "demo-bearer-token-must-be-min-16-chars",
  "dev-audit-gov-service-token",
  "dev-codegen-service-token",
  "dev-context-fabric-service-token",
  "dev-mcp-session-secret-min-32-chars!!",
  "dev-tool-grant-signing-secret-min-32-chars!!",
  "dev-workgraph-internal-token",
  "test-secret",
]);

export function platformWebProductionEnv(): string | null {
  for (const key of ["APP_ENV", "ENVIRONMENT", "SINGULARITY_ENV"]) {
    const value = process.env[key]?.trim().toLowerCase();
    if (value && PROD_ENVS.has(value)) return `${key}=${value}`;
    if (value && DEV_ENVS.has(value)) return null;
  }
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv && PROD_ENVS.has(nodeEnv)) return `NODE_ENV=${nodeEnv}`;
  return null;
}

export function platformWebCredentialError(name: string, value: string | null | undefined, minLength = 32): string | null {
  const prod = platformWebProductionEnv();
  if (!prod) return null;

  const current = value?.trim() ?? "";
  if (!current) return `${name} is required when ${prod}`;
  if (current.length < minLength) return `${name} must be at least ${minLength} characters when ${prod}`;
  if (KNOWN_DEV_DEFAULTS.has(current)) return `${name} still uses a development default while ${prod}`;
  if (/^(change-me|changeme|dev-|test-)/i.test(current)) return `${name} still looks like a development placeholder while ${prod}`;
  return null;
}
