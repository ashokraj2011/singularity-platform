import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors";
import { fail } from "../shared/response";
import { logger } from "../config/logger";

export function errorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    fail(res, 400, "VALIDATION_ERROR", "Invalid request payload", err.flatten());
    return;
  }
  if (err instanceof AppError) {
    fail(res, err.status, err.code, err.message, err.details);
    return;
  }
  logger.error({ err: err.message, stack: err.stack }, "unhandled error");
  fail(res, 500, "INTERNAL_ERROR", err.message ?? "Internal server error");
}
