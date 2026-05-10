import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[agent-service] error:", err.message);
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
}

export class AppError extends Error {
  constructor(public message: string, public status: number = 400) {
    super(message);
  }
}
