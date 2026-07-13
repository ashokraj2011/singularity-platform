import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { readUpstreamJsonObject } from "../shared/upstream-json";
import { boundedEnvInteger } from "../shared/env";

export interface AuthUser {
  user_id: string;
  email?: string;
  capability_ids?: string[];
  roles?: string[];
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
  user_id?: string;
  sub?: string;
  email?: string;
  is_super_admin?: boolean;
  roles?: string[];
  capability_ids?: string[];
};

type DecodedPrincipal = AuthUser & {
  sub?: string;
  kind?: string;
  service_name?: string;
  scopes?: string[];
  tenant_ids?: string[];
};

const IAM_AUTH_VERIFY_TIMEOUT_MS = boundedEnvInteger("IAM_AUTH_VERIFY_TIMEOUT_SEC", {
  defaultValue: 5,
  min: 1,
  max: 300,
}) * 1000;

function iamApiBase(): string | null {
  const raw = process.env.IAM_SERVICE_URL ?? process.env.IAM_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

// SECURITY: device/runtime tokens are valid ONLY on runtime-bridge/device
// surfaces — reject them here (returns null). is_super_admin is honored ONLY from
// real user tokens; service tokens are authorized by scope, not by an admin flag
// (prevents confused-deputy escalation via shared-secret JWTs).
function principalFromDecoded(decoded: DecodedPrincipal): AuthUser | null {
  const kind = typeof decoded.kind === "string" ? decoded.kind.toLowerCase() : "user";
  if (kind === "device" || kind === "runtime") return null;
  const isUser = kind === "user";
  return {
    ...decoded,
    user_id: decoded.user_id ?? decoded.sub ?? "",
    is_super_admin: isUser ? decoded.is_super_admin === true : false,
  };
}

function servicePrincipalFromToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET ?? "dev-secret-change-in-prod") as DecodedPrincipal;
    if (String(decoded.kind ?? "").toLowerCase() !== "service") return null;
    const configured = (process.env.IAM_SERVICE_TOKEN_TENANT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
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
      is_super_admin: false,
    };
  } catch {
    return null;
  }
}

async function authenticateToken(token: string): Promise<AuthUser | null> {
  const service = servicePrincipalFromToken(token);
  if (service) return service;
  if ((process.env.AUTH_PROVIDER ?? "local").toLowerCase() === "iam") return verifyWithIam(token);
  try {
    return principalFromDecoded(jwt.verify(token, process.env.JWT_SECRET ?? "dev-secret-change-in-prod") as DecodedPrincipal);
  } catch {
    return null;
  }
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
    const userId = me.user_id ?? me.id ?? me.sub;
    if (!userId) return null;
    return {
      user_id: userId,
      email: me.email,
      roles: me.roles,
      capability_ids: me.capability_ids,
      is_super_admin: Boolean(me.is_super_admin),
    };
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = header.slice(7);
  req.user = await authenticateToken(token) ?? undefined;
  if (!req.user) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    req.user = await authenticateToken(token) ?? undefined;
  }
  next();
}
