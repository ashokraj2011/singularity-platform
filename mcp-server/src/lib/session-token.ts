import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config";

export interface McpSessionClaims {
  iss: string;
  sub: string;
  jti: string;
  exp: number;
  iat: number;
  origin: "laptop" | "server-runtime" | string;
  client: string;
  invocationId?: string;
  agentRunId?: string;
  capabilityId?: string;
  scopes: string[];
}

const revoked = new Map<string, number>();

function secret(): string {
  return config.MCP_SESSION_JWT_SECRET || config.MCP_BEARER_TOKEN;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

function constantEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function cleanRevocations(nowSec: number): void {
  for (const [jti, exp] of revoked.entries()) {
    if (exp <= nowSec) revoked.delete(jti);
  }
}

export function mintMcpSessionToken(input: {
  subject: string;
  origin?: string;
  client?: string;
  invocationId?: string;
  agentRunId?: string;
  capabilityId?: string;
  scopes?: string[];
  ttlSeconds?: number;
}): { token: string; claims: McpSessionClaims } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? config.MCP_SESSION_TOKEN_TTL_SEC, 60), 7 * 24 * 60 * 60);
  const claims: McpSessionClaims = {
    iss: config.MCP_SESSION_TOKEN_ISSUER,
    sub: input.subject,
    jti: randomUUID(),
    iat: now,
    exp: now + ttl,
    origin: input.origin ?? "laptop",
    client: input.client ?? "unknown",
    invocationId: input.invocationId,
    agentRunId: input.agentRunId,
    capabilityId: input.capabilityId,
    scopes: input.scopes ?? ["tools:list", "tools:call", "resources:read", "events:read"],
  };
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = sign(`${header}.${payload}`);
  return { token: `${header}.${payload}.${signature}`, claims };
}

export function verifyMcpSessionToken(token: string): McpSessionClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed session token");
  const [header, payload, signature] = parts;
  const parsedHeader = parseJson<{ alg?: string; typ?: string }>(header);
  if (parsedHeader.alg !== "HS256") throw new Error("unsupported session token alg");
  const expected = sign(`${header}.${payload}`);
  if (!constantEqual(signature, expected)) throw new Error("invalid session token signature");
  const claims = parseJson<McpSessionClaims>(payload);
  const now = Math.floor(Date.now() / 1000);
  cleanRevocations(now);
  if (claims.iss !== config.MCP_SESSION_TOKEN_ISSUER) throw new Error("invalid issuer");
  if (claims.exp <= now) throw new Error("session token expired");
  if (revoked.has(claims.jti)) throw new Error("session token revoked");
  if (!Array.isArray(claims.scopes)) throw new Error("session token scopes missing");
  return claims;
}

export function revokeMcpSessionToken(jti: string, expiresAt?: number): void {
  revoked.set(jti, expiresAt ?? Math.floor(Date.now() / 1000) + config.MCP_SESSION_TOKEN_TTL_SEC);
}

export function hasMcpSessionScope(claims: McpSessionClaims, scope: string): boolean {
  return claims.scopes.includes(scope) || claims.scopes.includes("*");
}
