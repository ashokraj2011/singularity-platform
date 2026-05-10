import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

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

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.user = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthUser;
    } catch {
      // ignore — endpoints can choose to require auth via requireAuth
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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
