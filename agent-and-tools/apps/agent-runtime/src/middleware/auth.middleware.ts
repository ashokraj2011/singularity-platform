import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { readUpstreamJsonObject } from "../shared/upstream-json";

export interface AuthUser {
  user_id: string;
  email?: string;
  capability_ids?: string[];
  roles?: string[];
  // Effective platform-level permission keys from IAM /me (e.g. "platform:all"),
  // so gating can bind to the permission model instead of only role-name strings.
  permissions?: string[];
  is_platform_admin?: boolean;
  is_super_admin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

type IamMeResponse = {
  id?: string;
  email?: string;
  is_super_admin?: boolean;
  roles?: string[];
  capability_ids?: string[];
  permissions?: string[];
};

type DecodedPrincipal = AuthUser & {
  sub?: string;
  kind?: string;
  service_name?: string;
  scopes?: string[];
  tenant_ids?: string[];
  issued_by?: string;
};

const IAM_AUTH_VERIFY_TIMEOUT_MS = env.IAM_AUTH_VERIFY_TIMEOUT_SEC * 1000;

function iamApiBase(): string | null {
  const raw = env.IAM_SERVICE_URL ?? env.IAM_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

async function verifyWithIam(token: string): Promise<AuthUser | null> {
  const base = iamApiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(IAM_AUTH_VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const me = await readUpstreamJsonObject(res, "IAM /me") as IamMeResponse;
    if (!me.id) return null;
    return {
      user_id: me.id,
      email: me.email,
      roles: me.roles,
      capability_ids: me.capability_ids,
      permissions: me.permissions,
      is_super_admin: Boolean(me.is_super_admin),
      is_platform_admin: Boolean(me.is_super_admin),
    };
  } catch {
    return null;
  }
}

// SECURITY: device/runtime tokens are valid ONLY on the runtime bridge / device
// surfaces — never as a user identity on this REST API. is_super_admin is honored
// ONLY from real user tokens; service tokens are authorized by scope, not by an
// admin flag (prevents confused-deputy escalation via shared-secret JWTs).
function principalFromDecoded(decoded: DecodedPrincipal): AuthUser | null {
  const kind = typeof decoded.kind === "string" ? decoded.kind.toLowerCase() : "user";
  if (kind === "device" || kind === "runtime") return null;
  const isUser = kind === "user";
  return {
    ...decoded,
    user_id: decoded.user_id ?? decoded.sub ?? "",
    is_super_admin: isUser ? decoded.is_super_admin === true : false,
    is_platform_admin: isUser ? decoded.is_platform_admin === true : false,
  };
}

function servicePrincipalFromToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as DecodedPrincipal;
    if (String(decoded.kind ?? "").toLowerCase() !== "service") return null;
    const configured = env.IAM_SERVICE_TOKEN_TENANT_IDS.split(",").map((value) => value.trim()).filter(Boolean);
    if ((process.env.TENANT_ISOLATION_MODE ?? "").toLowerCase() === "strict" && configured.length === 0) return null;
    const tokenTenants = Array.isArray(decoded.tenant_ids)
      ? decoded.tenant_ids.filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : [];
    const expected = [...new Set(configured)].sort();
    const actual = [...new Set(tokenTenants)].sort();
    if (expected.length > 0 && (expected.length !== actual.length || expected.some((tenant, index) => tenant !== actual[index]))) return null;
    return {
      user_id: decoded.sub ?? `service:${decoded.service_name ?? "unknown"}`,
      email: `${decoded.service_name ?? "service"}@service.local`,
      roles: ["service"],
      capability_ids: [],
      permissions: decoded.scopes,
      is_super_admin: false,
      is_platform_admin: false,
    };
  } catch {
    return null;
  }
}

async function authenticateToken(token: string): Promise<AuthUser | null> {
  // Service tokens are explicitly scoped machine principals. They do not go
  // through IAM /me (which intentionally accepts real users only).
  const service = servicePrincipalFromToken(token);
  if (service) return service;
  if (env.AUTH_PROVIDER === "iam") return verifyWithIam(token);
  try {
    return principalFromDecoded(jwt.verify(token, env.JWT_SECRET) as DecodedPrincipal) ?? null;
  } catch {
    return null;
  }
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    req.user = await authenticateToken(token) ?? undefined;
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) await optionalAuth(req, res, () => undefined);
  if (!req.user) {
    res.status(401).json({
      success: false, data: null,
      error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
      requestId: res.locals.requestId ?? null,
    });
    return;
  }
  next();
}
