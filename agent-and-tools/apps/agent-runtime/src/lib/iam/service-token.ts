import jwt from "jsonwebtoken";
import { env } from "../../config/env";

const SERVICE_NAME = "agent-runtime";
const SCOPES = ["read:reference-data", "write:reference-data", "publish:events"];
const REFRESH_BUFFER_HOURS = 24;
const TTL_HOURS = 24 * 30;

interface CachedToken {
  jwt: string;
  expiresAt: Date;
}

let cached: CachedToken | null = null;
let inflight: Promise<string | undefined> | null = null;

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeExp(token: string): Date | null {
  const payload = decodePayload(token);
  return typeof payload?.exp === "number" ? new Date(payload.exp * 1000) : null;
}

function isProductionClassEnv(): boolean {
  const prodEnvs = new Set(["production", "prod", "staging", "perf"]);
  return [env.NODE_ENV, process.env.APP_ENV, process.env.ENVIRONMENT, process.env.SINGULARITY_ENV]
    .some((value) => Boolean(value && prodEnvs.has(value.toLowerCase())));
}

export function configuredTenantIdsForServiceToken(): string[] {
  return [...new Set(
    env.IAM_SERVICE_TOKEN_TENANT_IDS
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function validateIamServiceTokenTenantScope(token: string | undefined): boolean {
  if ((process.env.TENANT_ISOLATION_MODE ?? "").toLowerCase() !== "strict") return true;
  const required = configuredTenantIdsForServiceToken();
  if (required.length === 0) {
    console.warn("[agent-runtime iam-service-token] TENANT_ISOLATION_MODE=strict requires IAM_SERVICE_TOKEN_TENANT_IDS");
    return false;
  }
  const payload = token ? decodePayload(token) : null;
  const rawTenantIds = payload?.tenant_ids;
  const actual = Array.isArray(rawTenantIds)
    ? [...new Set(rawTenantIds
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim()))].sort()
    : [];
  if (!sameStringSet(actual, required)) {
    console.warn("[agent-runtime iam-service-token] service token tenant_ids do not match IAM_SERVICE_TOKEN_TENANT_IDS");
    return false;
  }
  return true;
}

function iamApiBase(): string | undefined {
  const raw = (env.IAM_BASE_URL ?? env.IAM_SERVICE_URL)?.replace(/\/+$/, "");
  if (!raw) return undefined;
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}

function isFresh(token: CachedToken | null): token is CachedToken {
  if (!token) return false;
  const ms = token.expiresAt.getTime() - Date.now();
  return ms > REFRESH_BUFFER_HOURS * 3600 * 1000;
}

function devSelfSignedToken(): string | undefined {
  if (isProductionClassEnv()) return undefined;
  const secret = env.JWT_SECRET?.trim();
  if (!secret) return undefined;
  return jwt.sign({
    sub: `service:${SERVICE_NAME}`,
    kind: "service",
    service_name: SERVICE_NAME,
    scopes: ["read:reference-data", "write:reference-data", "publish:events"],
    tenant_ids: configuredTenantIdsForServiceToken(),
    issued_by: SERVICE_NAME,
    is_super_admin: true,
  }, secret, {
    algorithm: "HS256",
    expiresIn: "30d",
  });
}

async function mint(): Promise<string | undefined> {
  const base = iamApiBase();
  const username = process.env.IAM_BOOTSTRAP_USERNAME;
  const password = process.env.IAM_BOOTSTRAP_PASSWORD;
  if (!base || !username || !password) return devSelfSignedToken();

  const loginRes = await fetch(`${base}/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginRes.ok) {
    console.warn(`[agent-runtime iam-service-token] bootstrap login failed (${loginRes.status})`);
    return devSelfSignedToken();
  }
  const loginBody = await loginRes.json() as { access_token?: string };
  const userJwt = loginBody.access_token;
  if (!userJwt) return devSelfSignedToken();

  const mintRes = await fetch(`${base}/auth/service-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userJwt}` },
    body: JSON.stringify({
      service_name: SERVICE_NAME,
      scopes: SCOPES,
      tenant_ids: configuredTenantIdsForServiceToken(),
      ttl_hours: TTL_HOURS,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!mintRes.ok) {
    console.warn(`[agent-runtime iam-service-token] mint failed (${mintRes.status}): ${(await mintRes.text()).slice(0, 200)}`);
    return devSelfSignedToken();
  }
  const body = await mintRes.json() as { access_token?: string };
  const serviceJwt = body.access_token;
  if (!serviceJwt || !validateIamServiceTokenTenantScope(serviceJwt)) return undefined;

  const expiresAt = decodeExp(serviceJwt) ?? new Date(Date.now() + TTL_HOURS * 3600 * 1000);
  cached = { jwt: serviceJwt, expiresAt };
  console.log(`[agent-runtime iam-service-token] minted ${SERVICE_NAME} token; expires ${expiresAt.toISOString()}`);
  return serviceJwt;
}

export async function getIamServiceToken(): Promise<string | undefined> {
  if (env.IAM_SERVICE_TOKEN) {
    return validateIamServiceTokenTenantScope(env.IAM_SERVICE_TOKEN) ? env.IAM_SERVICE_TOKEN : undefined;
  }
  if (isFresh(cached)) return cached.jwt;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return await mint();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getIamServiceAuthHeader(): Promise<string | undefined> {
  const token = await getIamServiceToken();
  if (!token) return undefined;
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

export function invalidateIamServiceToken(): void {
  cached = null;
}
