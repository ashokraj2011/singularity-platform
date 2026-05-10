import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  user_id: string;
  capability_ids?: string[];
  roles?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Stub: validates JWT and attaches user. Replace with real IAM call if needed.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  try {
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET ?? "dev-secret-change-in-prod";
    const decoded = jwt.verify(token, secret) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Allows unauthenticated access in dev, attaches stub user.
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const token = header.slice(7);
      const secret = process.env.JWT_SECRET ?? "dev-secret-change-in-prod";
      req.user = jwt.verify(token, secret) as AuthUser;
    } catch {
      // ignore — optional
    }
  }
  next();
}
