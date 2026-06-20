import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";

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

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function serviceTokens(): string[] {
  return [
    process.env.PROMPT_COMPOSER_SERVICE_TOKEN,
    env.CONTEXT_FABRIC_SERVICE_TOKEN,
  ].map((token) => token?.trim()).filter((token): token is string => Boolean(token));
}

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

function verifyServiceToken(token: string): AuthUser | null {
  for (const expected of serviceTokens()) {
    if (constantTimeEqual(token, expected)) {
      return {
        user_id: "service:prompt-composer-client",
        roles: ["service"],
      };
    }
  }
  return null;
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

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    try {
      req.user = userFromDecoded(jwt.verify(token, env.JWT_SECRET) as AuthUser & { sub?: string });
    } catch {
      req.user = verifyServiceToken(token) ?? await verifyWithIam(token) ?? undefined;
    }
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  await optionalAuth(req, res, () => undefined);
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
