import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const id = incoming ?? `req-${uuidv4()}`;
  res.locals.requestId = id;
  res.setHeader("x-request-id", id);
  next();
}
