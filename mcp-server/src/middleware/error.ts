import { Request, Response, NextFunction } from "express";
import { AppError } from "../shared/errors";
import { log } from "../shared/log";

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
      requestId: res.locals.requestId ?? null,
    });
    return;
  }
  log.error({ err: err.message, stack: err.stack }, "unhandled error");
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: err.message ?? "internal" },
    requestId: res.locals.requestId ?? null,
  });
}
