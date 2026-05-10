import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { UnauthorizedError } from "../shared/errors";

/**
 * Bearer-token auth.
 *
 * context-fabric (or any other caller registered in IAM's mcp_servers) sends:
 *     Authorization: Bearer <MCP_BEARER_TOKEN>
 * Same value lives in this server's env and in IAM's iam.mcp_servers.bearer_token
 * column for the matching capability.
 */
export function bearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("missing bearer token");
  const presented = header.slice(7);
  if (presented !== config.MCP_BEARER_TOKEN) throw new UnauthorizedError("bearer mismatch");
  next();
}
