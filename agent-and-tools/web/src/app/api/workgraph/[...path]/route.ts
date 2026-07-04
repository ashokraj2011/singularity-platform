import { NextRequest, NextResponse } from "next/server";
import { proxyHeaders, proxyRequest, requireVerifiedCallerBearer } from "../../_proxy";
import { jsonishMessage, readJsonish } from "../../_json";
import { platformWebCredentialError, platformWebProductionEnv } from "@/lib/serverEnvGuard";
import { serverEnv } from "@/lib/serverRootEnv";
import { iamApiBase, platformServiceUrl } from "@/lib/platformServices";

const WORKGRAPH_API_URL = platformServiceUrl("workgraph-api");
const IAM_BASE_URL = iamApiBase();
const SERVICE_AUTH_ENABLED = (serverEnv("WORKGRAPH_PROXY_SERVICE_AUTH", "false") ?? "false").toLowerCase() === "true";
const SERVICE_NAME = "platform-web";
const SERVICE_SCOPES = ["read:reference-data", "read:mcp-servers", "publish:events"];
const TENANT_ISOLATION_MODE = (serverEnv("TENANT_ISOLATION_MODE", "off") ?? "off").trim().toLowerCase();
const REQUIRE_TENANT_ID = (serverEnv("REQUIRE_TENANT_ID", "false") ?? "false").trim().toLowerCase();

let cachedServiceToken: { token: string; expiresAt: number } | null = null;

type ServiceTokenResult =
  | { token: string; failure?: undefined }
  | { token: null; failure?: { code: string; message: string; details?: Record<string, unknown> } };

function normalizeWorkgraphPath(parts: string[]): string {
  if (!parts.length) return "";
  const [head, ...rest] = parts;
  const aliases: Record<string, string> = {
    templates: "workflow-templates",
    template: "workflow-templates",
    instances: "workflow-instances",
    "workflow-runs": "workflow-instances",
    metadata: "metadata-definitions",
  };
  return [aliases[head] ?? head, ...rest].join("/");
}

function allowsServiceTokenRetry(req: NextRequest, suffix: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const callerAuth = req.headers.get("authorization") ?? "";
  if (!callerAuth.startsWith("Bearer ")) return false;
  return suffix === "lookup"
    || suffix.startsWith("lookup/")
    || suffix === "tool-registry"
    || suffix.startsWith("tool-registry/");
}

function decodeJwtExpiry(token: string): number {
  try {
    const [, payload] = token.split(".");
    if (!payload) return 0;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isJwtLike(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.trim());
}

function configuredTenantIds(): string[] {
  return [...new Set(
    (serverEnv("IAM_SERVICE_TOKEN_TENANT_IDS") ?? "")
      .split(",")
      .map((tenantId) => tenantId.trim())
      .filter(Boolean),
  )].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function tenantScopedTokenRequired(): boolean {
  return Boolean(platformWebProductionEnv()) || TENANT_ISOLATION_MODE === "strict" || REQUIRE_TENANT_ID === "true" || configuredTenantIds().length > 0;
}

function workgraphProxyTokenError(token: string | undefined): string | null {
  const unsafe = platformWebCredentialError("WORKGRAPH_PROXY_SERVICE_TOKEN", token);
  if (unsafe) return unsafe;
  if (token && !isJwtLike(token)) {
    return "WORKGRAPH_PROXY_SERVICE_TOKEN must be a pre-minted IAM service JWT for platform-web -> Workgraph proxy auth.";
  }
  if (token) {
    const payload = decodeJwtPayload(token);
    if (!payload || payload.kind !== "service" || payload.service_name !== SERVICE_NAME || payload.sub !== `service:${SERVICE_NAME}`) {
      return "WORKGRAPH_PROXY_SERVICE_TOKEN must be an IAM service JWT minted for platform-web.";
    }
    const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((scope): scope is string => typeof scope === "string") : [];
    const missingScopes = SERVICE_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      return `WORKGRAPH_PROXY_SERVICE_TOKEN is missing required scope(s): ${missingScopes.join(", ")}.`;
    }
    const tenantIds = Array.isArray(payload.tenant_ids) ? [...new Set(payload.tenant_ids.filter((tenantId): tenantId is string => typeof tenantId === "string" && tenantId.trim() !== "").map((tenantId) => tenantId.trim()))].sort() : [];
    const requiredTenantIds = configuredTenantIds();
    if (requiredTenantIds.length > 0 && !sameStringSet(tenantIds, requiredTenantIds)) {
      return "WORKGRAPH_PROXY_SERVICE_TOKEN tenant_ids must exactly match IAM_SERVICE_TOKEN_TENANT_IDS.";
    }
    if (tenantScopedTokenRequired() && tenantIds.length === 0) {
      return "WORKGRAPH_PROXY_SERVICE_TOKEN must carry tenant_ids when tenant-scoped runtime is enabled.";
    }
  }
  return null;
}

async function readJsonObject(res: Response, source: string): Promise<Record<string, unknown>> {
  const body = await readJsonish(res);
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>;
  }
  throw new Error(`${source} returned invalid JSON (${res.status}): ${body.text || body.parseError || res.statusText || "empty body"}`);
}

function tokenMintFailure(message: string, details?: Record<string, unknown>): ServiceTokenResult {
  return {
    token: null,
    failure: {
      code: "WORKGRAPH_PROXY_TOKEN_MINT_FAILED",
      message,
      ...(details ? { details } : {}),
    },
  };
}

async function getServiceToken(): Promise<ServiceTokenResult> {
  const pinned = serverEnv("WORKGRAPH_PROXY_SERVICE_TOKEN");
  if (pinned) return workgraphProxyTokenError(pinned) ? { token: null } : { token: pinned };
  if (platformWebProductionEnv()) return { token: null };
  const tenantIds = configuredTenantIds();
  if (tenantScopedTokenRequired() && tenantIds.length === 0) return { token: null };
  if (cachedServiceToken && cachedServiceToken.expiresAt - Date.now() > 24 * 60 * 60 * 1000) {
    return { token: cachedServiceToken.token };
  }

  const email = serverEnv("IAM_BOOTSTRAP_USERNAME");
  const password = serverEnv("IAM_BOOTSTRAP_PASSWORD");
  if (!email || !password) return { token: null };

  const base = IAM_BASE_URL.replace(/\/$/, "");
  let login: Response;
  try {
    login = await fetch(`${base}/auth/local/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    return tokenMintFailure(`IAM bootstrap login request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!login.ok) {
    const body = await readJsonish(login);
    return tokenMintFailure(
      `IAM bootstrap login failed (${login.status}): ${jsonishMessage(body.data, body.text || login.statusText || "login failed")}`,
      { status: login.status, body: body.text },
    );
  }
  let loginBody: Record<string, unknown>;
  try {
    loginBody = await readJsonObject(login, "IAM bootstrap login");
  } catch (err) {
    return tokenMintFailure(err instanceof Error ? err.message : String(err));
  }
  const loginToken = typeof loginBody.access_token === "string" ? loginBody.access_token : null;
  if (!loginToken) return tokenMintFailure("IAM bootstrap login response did not include access_token.");

  let minted: Response;
  try {
    minted = await fetch(`${base}/auth/service-token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loginToken}` },
      body: JSON.stringify({ service_name: SERVICE_NAME, scopes: SERVICE_SCOPES, tenant_ids: tenantIds, ttl_hours: 24 * 30 }),
    });
  } catch (err) {
    return tokenMintFailure(`IAM service-token mint request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!minted.ok) {
    const body = await readJsonish(minted);
    return tokenMintFailure(
      `IAM service-token mint failed (${minted.status}): ${jsonishMessage(body.data, body.text || minted.statusText || "mint failed")}`,
      { status: minted.status, body: body.text },
    );
  }
  let mintedBody: Record<string, unknown>;
  try {
    mintedBody = await readJsonObject(minted, "IAM service-token mint");
  } catch (err) {
    return tokenMintFailure(err instanceof Error ? err.message : String(err));
  }
  const mintedToken = typeof mintedBody.access_token === "string" ? mintedBody.access_token : null;
  if (!mintedToken) return tokenMintFailure("IAM service-token mint response did not include access_token.");

  cachedServiceToken = {
    token: mintedToken,
    expiresAt: decodeJwtExpiry(mintedToken) || Date.now() + 29 * 24 * 60 * 60 * 1000,
  };
  return { token: cachedServiceToken.token };
}

async function proxy(req: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const params = await context.params;
  const suffix = normalizeWorkgraphPath(params.path ?? []);
  const search = req.nextUrl.search ?? "";
  const base = WORKGRAPH_API_URL.replace(/\/$/, "");
  const upstreamPath = suffix === "health" ? "/health" : `/api/${suffix}`;
  const upstream = `${base}${upstreamPath}${search}`;
  const first = await proxyRequest(req, upstream, proxyHeaders(req, WORKGRAPH_API_URL), { normalizeTextErrors: true });
  if (first.status !== 401 || !SERVICE_AUTH_ENABLED || !allowsServiceTokenRetry(req, suffix)) return first;

  const authFailure = await requireVerifiedCallerBearer(req, "Workgraph");
  if (authFailure) return authFailure;

  if (platformWebProductionEnv() && !serverEnv("WORKGRAPH_PROXY_SERVICE_TOKEN")) {
    return NextResponse.json(
      {
        code: "PLATFORM_WEB_CREDENTIAL_UNSAFE",
        message: "WORKGRAPH_PROXY_SERVICE_TOKEN is required for platform-web service auth in production-class environments; IAM bootstrap credentials are development-only.",
      },
      { status: 503 },
    );
  }

  const serviceTokenResult = await getServiceToken();
  const serviceToken = serviceTokenResult.token;
  if (!serviceToken) {
    if (serviceTokenResult.failure) {
      return NextResponse.json(serviceTokenResult.failure, { status: 503 });
    }
    const error = workgraphProxyTokenError(serverEnv("WORKGRAPH_PROXY_SERVICE_TOKEN"));
    if (error) return NextResponse.json({ code: "PLATFORM_WEB_CREDENTIAL_UNSAFE", message: error }, { status: 503 });
    if (tenantScopedTokenRequired() && configuredTenantIds().length === 0) {
      return NextResponse.json(
        {
          code: "PLATFORM_WEB_CREDENTIAL_UNSAFE",
          message: "IAM_SERVICE_TOKEN_TENANT_IDS is required before Platform Web can mint a Workgraph proxy token for tenant-scoped runtime.",
        },
        { status: 503 },
      );
    }
    return first;
  }
  const headers = proxyHeaders(req, WORKGRAPH_API_URL);
  headers.set("authorization", `Bearer ${serviceToken}`);
  return proxyRequest(req, upstream, headers, { normalizeTextErrors: true });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
