import { Router } from "express";
import { z } from "zod";
import { isStaticBearerToken } from "../middleware/auth";
import { mintMcpSessionToken, revokeMcpSessionToken, verifyMcpSessionToken } from "../lib/session-token";

export const tokensRouter = Router();

const mintSchema = z.object({
  subject: z.string().min(1).default("laptop-user"),
  origin: z.string().default("laptop"),
  client: z.string().default("unknown"),
  invocationId: z.string().optional(),
  agentRunId: z.string().optional(),
  capabilityId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

function requireStaticBearer(req: { headers: { authorization?: string } }): void {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !isStaticBearerToken(token)) {
    const err = new Error("static MCP bearer token required");
    (err as { status?: number }).status = 403;
    throw err;
  }
}

tokensRouter.post("/tokens", (req, res) => {
  requireStaticBearer(req);
  const parsed = mintSchema.parse(req.body ?? {});
  const { token, claims } = mintMcpSessionToken(parsed);
  res.status(201).json({
    token,
    jti: claims.jti,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    scopes: claims.scopes,
    origin: claims.origin,
    client: claims.client,
  });
});

tokensRouter.post("/tokens/:jti/revoke", (req, res) => {
  requireStaticBearer(req);
  revokeMcpSessionToken(String(req.params.jti));
  res.json({ revoked: true, jti: String(req.params.jti) });
});

tokensRouter.post("/tokens/introspect", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) return res.status(400).json({ active: false, error: "token required" });
  try {
    const claims = verifyMcpSessionToken(token);
    return res.json({
      active: true,
      jti: claims.jti,
      subject: claims.sub,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      origin: claims.origin,
      client: claims.client,
      scopes: claims.scopes,
      invocationId: claims.invocationId,
      agentRunId: claims.agentRunId,
      capabilityId: claims.capabilityId,
    });
  } catch (err) {
    return res.json({ active: false, error: (err as Error).message });
  }
});
