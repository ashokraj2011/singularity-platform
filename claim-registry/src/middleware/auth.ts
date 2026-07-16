import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { runWithRegistryActor, type RegistryActor } from '../lib/request-context';

declare global {
  namespace Express {
    interface Request {
      registryActor?: RegistryActor;
    }
  }
}

type VerifiedIdentity = {
  id?: string;
  user_id?: string;
  sub?: string;
  email?: string;
  tenant_ids?: string[];
  tenant_id?: string;
  kind?: string;
  is_service?: boolean;
};

function bearer(req: Request): string | undefined {
  const value = req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

function decodedPayload(token: string): Record<string, unknown> {
  const raw = token.split('.')[1];
  if (!raw) throw new Error('Malformed bearer token');
  const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Bearer token has expired');
  return payload;
}

function verifyHs256(token: string, secret: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('Unsupported local JWT algorithm');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const received = Buffer.from(parts[2]!, 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid JWT signature');
  return decodedPayload(token);
}

async function verifyWithIam(token: string): Promise<VerifiedIdentity> {
  const base = (process.env.IAM_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('IAM_BASE_URL is required when CLAIM_REGISTRY_AUTH_PROVIDER=iam');
  const serviceToken = process.env.IAM_SERVICE_TOKEN;
  const verifyResponse = await fetch(`${base}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}) },
    body: JSON.stringify({ token }),
  });
  if (verifyResponse.ok) {
    const body = await verifyResponse.json() as { valid?: boolean; user?: VerifiedIdentity; reason?: string };
    if (!body.valid || !body.user) throw new Error(body.reason ?? 'IAM rejected the bearer token');
    return body.user;
  }
  if (verifyResponse.status !== 404) throw new Error(`IAM rejected the bearer token (${verifyResponse.status})`);
  const me = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!me.ok) throw new Error(`IAM rejected the bearer token (${me.status})`);
  return await me.json() as VerifiedIdentity;
}

function tenantFor(identity: VerifiedIdentity, req: Request): string {
  const claimed = [
    ...(Array.isArray(identity.tenant_ids) ? identity.tenant_ids : []),
    ...(typeof identity.tenant_id === 'string' ? [identity.tenant_id] : []),
  ].map((x) => x.trim()).filter(Boolean);
  const available = [...new Set(claimed)];
  const requested = (req.header('x-tenant-id') ?? req.header('x-singularity-tenant-id') ?? '').trim();
  const strict = String(process.env.TENANT_ISOLATION_MODE ?? 'strict').toLowerCase() === 'strict';
  if (requested) {
    if (strict && !available.includes(requested)) throw new Error('Requested tenant is not present in the authenticated token');
    if (!strict && available.length > 0 && !available.includes(requested)) throw new Error('Requested tenant is not present in the authenticated token');
    return requested;
  }
  if (available.length === 1) return available[0]!;
  if (strict && available.length !== 1) throw new Error('A tenant header is required when the token has multiple or no tenant memberships');
  return process.env.CLAIM_REGISTRY_DEFAULT_TENANT_ID?.trim() || 'default';
}

export const registryAuth: RequestHandler = async (req, res, next) => {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Claim Registry requires a bearer token' });
    return;
  }
  try {
    const provider = (process.env.CLAIM_REGISTRY_AUTH_PROVIDER ?? process.env.AUTH_PROVIDER ?? 'iam').toLowerCase();
    const identity = provider === 'local' ? verifyHs256(token, process.env.JWT_SECRET ?? '') : await verifyWithIam(token);
    const userId = String(identity.id ?? identity.user_id ?? identity.sub ?? '').trim();
    if (!userId) throw new Error('Authenticated identity has no subject');
    const kind = String(identity.kind ?? '').toLowerCase() === 'service' || identity.is_service === true || String(identity.email ?? '').endsWith('@service.local') ? 'service' : 'user';
    const actor: RegistryActor = { userId, tenantId: tenantFor(identity, req), kind };
    req.registryActor = actor;
    runWithRegistryActor(actor, next);
  } catch (error) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: error instanceof Error ? error.message : 'Invalid bearer token' });
  }
};

export const requireServicePrincipal: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (req.registryActor?.kind !== 'service') {
    res.status(403).json({ code: 'SERVICE_PRINCIPAL_REQUIRED', message: 'This operation requires an authenticated service principal' });
    return;
  }
  next();
};
