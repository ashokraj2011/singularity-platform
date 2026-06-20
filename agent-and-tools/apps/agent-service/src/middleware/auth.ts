import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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

function iamApiBase(): string | null {
  const raw = process.env.IAM_SERVICE_URL ?? process.env.IAM_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function userFromDecoded(decoded: AuthUser & { sub?: string }): AuthUser {
  return {
    ...decoded,
    user_id: decoded.user_id ?? decoded.sub ?? "",
  };
}

async function verifyWithIam(token: string): Promise<AuthUser | null> {
  const base = iamApiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const me = await res.json() as IamMeResponse;
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
  try {
    const secret = process.env.JWT_SECRET ?? "dev-secret-change-in-prod";
    req.user = userFromDecoded(jwt.verify(token, secret) as AuthUser & { sub?: string });
  } catch {
    req.user = await verifyWithIam(token) ?? undefined;
  }
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
    try {
      const secret = process.env.JWT_SECRET ?? "dev-secret-change-in-prod";
      req.user = userFromDecoded(jwt.verify(token, secret) as AuthUser & { sub?: string });
    } catch {
      req.user = await verifyWithIam(token) ?? undefined;
    }
  }
  next();
}
