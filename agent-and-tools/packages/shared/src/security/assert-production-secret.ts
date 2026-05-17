/**
 * M35.1 — Production secret safety gate.
 *
 * Boot-time invariant: in production-class environments (NODE_ENV=production,
 * staging, prod, perf), refuse to start when a critical secret is still set to
 * a hardcoded development default OR is shorter than the entropy minimum.
 *
 * Use at module load time at every service entry:
 *
 *   import { assertProductionSecret } from "@agentandtools/shared";
 *   assertProductionSecret({ name: "JWT_SECRET", value: process.env.JWT_SECRET });
 */
export interface AssertSecretInput {
  /** Env var name — used in the error message. */
  name: string;
  /** Current value (may be undefined). */
  value: string | undefined;
  /** Min entropy in characters. Default 32. */
  minLength?: number;
  /** Extra known-bad defaults this caller wants to reject. */
  extraBadValues?: string[];
  /** Override NODE_ENV detection (mostly for tests). */
  nodeEnv?: string;
}

/** The catalogue of dev defaults that every service in the monorepo has
 *  baked into config fallbacks. Add to this list as new ones are found. */
const KNOWN_DEV_DEFAULTS: ReadonlySet<string> = new Set([
  "dev-secret-change-in-prod",
  "dev-secret-change-in-prod-min-32-chars!!",
  "changeme_dev_only_min_32_chars_long!!",
  "demo-bearer-token-must-be-min-16-chars",
  "dev-audit-gov-service-token",
  "changeme",
  "test-secret",
]);

const PROD_ENVS = new Set(["production", "prod", "staging", "perf"]);

export function assertProductionSecret(input: AssertSecretInput): void {
  const env = (input.nodeEnv ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (!PROD_ENVS.has(env)) return; // dev mode: tolerate weak secrets

  const value = input.value ?? "";
  const minLength = input.minLength ?? 32;
  const reasons: string[] = [];

  if (value.length === 0) {
    reasons.push("unset");
  } else if (value.length < minLength) {
    reasons.push(`shorter than ${minLength} chars (got ${value.length})`);
  }
  if (KNOWN_DEV_DEFAULTS.has(value)) {
    reasons.push("matches a known development default");
  }
  for (const bad of input.extraBadValues ?? []) {
    if (value === bad) reasons.push(`matches caller-supplied bad value`);
  }

  if (reasons.length > 0) {
    const msg = `FATAL: ${input.name} is unsafe for NODE_ENV=${env}: ${reasons.join("; ")}. Set ${input.name} to a strong random value (${minLength}+ chars) and restart.`;
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}
