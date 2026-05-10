import { Response } from "express";

export function ok<T>(res: Response, data: T, status: number = 200): Response {
  return res.status(status).json({
    success: true,
    data,
    error: null,
    requestId: res.locals.requestId ?? null,
  });
}

export function fail(res: Response, status: number, code: string, message: string, details?: unknown): Response {
  return res.status(status).json({
    success: false,
    data: null,
    error: { code, message, details: details ?? [] },
    requestId: res.locals.requestId ?? null,
  });
}
