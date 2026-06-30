/**
 * Runtime token claims (P0 #2).
 *
 * Decodes the dialed-in runtime's OWN JWT to read token-authoritative facts —
 * notably `shared` — for local security decisions (the shared-runtime git guard
 * + source-discover). This is NOT a verification: Context Fabric's bridge does
 * the authoritative verify on connect; here we only read claims to decide
 * whether this process may carry a process-global git token.
 *
 * `shared` precedence: the token's `shared` claim wins (authoritative); when the
 * token carries no such claim we fall back to the local SINGULARITY_RUNTIME_SHARED
 * env flag (the pre-broker behavior).
 */
export interface RuntimeClaims {
  shared: boolean;
  userId?: string;
  tenantId?: string;
  runtimeId?: string;
}

let _cached: RuntimeClaims | null = null;

function _decodePayload(token: string): Record<string, unknown> {
  const seg = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function runtimeClaims(): RuntimeClaims {
  if (_cached) return _cached;
  const token = process.env.SINGULARITY_RUNTIME_TOKEN ?? process.env.SINGULARITY_DEVICE_TOKEN;
  const envShared = String(process.env.SINGULARITY_RUNTIME_SHARED ?? "false").toLowerCase() === "true";
  let claims: Record<string, unknown> = {};
  if (token) {
    try {
      claims = _decodePayload(token);
    } catch {
      claims = {};
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  _cached = {
    shared: claims.shared === true || (claims.shared === undefined && envShared),
    userId: str(claims.sub) ?? str(claims.user_id),
    tenantId: str(claims.tenant_id),
    runtimeId: str(claims.runtime_id),
  };
  return _cached;
}

export function isSharedRuntime(): boolean {
  return runtimeClaims().shared;
}

/** True when any process-global static git token env is set (the thing a shared
 *  runtime must NOT carry — it would attribute every user's push to one identity). */
export function staticGitTokenPresent(): boolean {
  const envName = process.env.MCP_GIT_TOKEN_ENV;
  return Boolean(
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.MCP_GIT_TOKEN?.trim() ||
    (envName ? process.env[envName]?.trim() : undefined),
  );
}

/** Opt-in hard gate: when true, a shared runtime carrying a static git token is
 *  fatal at boot (and source-discover suppresses the static token). Default off
 *  so existing shared deployments keep working until brokered creds are wired on. */
export function gitBrokerEnforce(): boolean {
  return String(process.env.MCP_GIT_BROKER_ENFORCE ?? "false").toLowerCase() === "true";
}
