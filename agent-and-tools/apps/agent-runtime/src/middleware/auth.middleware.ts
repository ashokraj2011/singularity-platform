import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { readUpstreamJsonObject } from "../shared/upstream-json";

export interface AuthUser {
  user_id: string;
  email?: string;
  capability_ids?: string[];
  roles?: string[];
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
};

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
    const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const me = await readUpstreamJsonObject(res, "IAM /me") as IamMeResponse;
    if (!me.id) return null;
    return {
      user_id: me.id,
      email: me.email,
      roles: me.roles,
      capability_ids: me.capability_ids,
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
function principalFromDecoded(decoded: AuthUser & { sub?: string; kind?: string }): AuthUser | null {
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

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser & { sub?: string; kind?: string };
      req.user = principalFromDecoded(decoded) ?? undefined;
    } catch {
      req.user = await verifyWithIam(token) ?? undefined;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    next();
    return;
  }
  optionalAuth(req, res, () => {
    if (!req.user) {
      res.status(401).json({
        success: false, data: null,
        error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
        requestId: res.locals.requestId ?? null,
      });
      return;
    }
    next();
  });
}
