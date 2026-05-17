import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { UnauthorizedError } from "../shared/errors";

/**
 * Bearer-token auth (M35.1).
 *
 * context-fabric (or any other caller registered in IAM's mcp_servers) sends:
 *     Authorization: Bearer <MCP_BEARER_TOKEN>
 * Same value lives in this server's env and in IAM's iam.mcp_servers.bearer_token
 * column for the matching capability.
 *
 * Comparison is constant-time via `crypto.timingSafeEqual` to close a
 * length-extension timing attack on the bearer token.
 */
function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length inputs; coerce to same length so
  // we don't leak length information either.
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against a buffer of the same length anyway to keep timing
    // independent of which side was longer.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function bearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("missing bearer token");
  const presented = header.slice(7);
  if (!constantTimeEqual(presented, config.MCP_BEARER_TOKEN)) {
    throw new UnauthorizedError("bearer mismatch");
  }
  next();
}
