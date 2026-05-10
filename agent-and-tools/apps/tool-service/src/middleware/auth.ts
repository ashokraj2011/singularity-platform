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

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const token = header.slice(7);
      const secret = process.env.JWT_SECRET ?? "dev-secret-change-in-prod";
      req.user = jwt.verify(token, secret) as AuthUser;
    } catch {
      // ignore
    }
  }
  next();
}
