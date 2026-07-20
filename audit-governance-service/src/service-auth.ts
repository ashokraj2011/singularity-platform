/**
 * M35.1 — the shared service-auth gate for every mutating/reading router here.
 *
 * Extracted from routes-events.ts to break a real import cycle:
 * routes-events imports broadcastAuditEvent from routes-stream, and
 * routes-stream imported requireServiceAuth back from routes-events. Under
 * tsc's CommonJS output that happens to resolve (tsc hoists the
 * `exports.x = x` assignments for function declarations above the requires,
 * so production boot was never affected), but under any ESM-semantics loader —
 * vitest/esbuild, or a future "type": "module" — the live binding is still in
 * its temporal dead zone when routes-stream's module body runs, and
 * `streamRouter.use(undefined)` throws "Router.use() requires a middleware
 * function" at import time.
 *
 * Behaviour is unchanged; this file is a pure move. routes-events re-exports
 * the symbol so the seven other routers that import it from there keep working.
 */
import { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

const SERVICE_TOKEN = process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";
// M35.1 — anonymous mode is OPT-IN only. Previously it auto-enabled when
// SERVICE_TOKEN was unset in non-production NODE_ENV; that silently allowed
// unauthenticated event ingest whenever someone forgot to set the env var.
// Now you MUST explicitly set AUDIT_GOV_ALLOW_ANONYMOUS_DEV=1 to allow it.
const ALLOW_ANON_DEV = process.env.AUDIT_GOV_ALLOW_ANONYMOUS_DEV === "1";

export function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : String(req.headers["x-service-token"] ?? "");
  if (SERVICE_TOKEN) {
    // Constant-time compare to close a timing side-channel on the token.
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(SERVICE_TOKEN, "utf8");
    const lenOk = a.length === b.length;
    const eq = lenOk ? timingSafeEqual(a, b) : (timingSafeEqual(b, Buffer.alloc(b.length)), false);
    if (!eq) {
      res.status(401).json({ error: "invalid service token" });
      return;
    }
    next();
    return;
  }
  if (!ALLOW_ANON_DEV) {
    res.status(503).json({ error: "AUDIT_GOV_SERVICE_TOKEN is required" });
    return;
  }
  next();
}
