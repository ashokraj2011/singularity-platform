import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registryAuth } from '../src/middleware/auth';
import { currentRegistryActor } from '../src/lib/request-context';

function request(headers: Record<string, string> = {}): Request {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { header: (name: string) => normalized[name.toLowerCase()] } as unknown as Request;
}

function response() {
  const result: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) { result.statusCode = code; return res; },
    json(body: unknown) { result.body = body; return res; },
  } as unknown as Response;
  return { res, result };
}

describe('Claim Registry request authentication', () => {
  beforeEach(() => {
    process.env.CLAIM_REGISTRY_AUTH_PROVIDER = 'iam';
    process.env.IAM_BASE_URL = 'http://iam.test/api/v1';
    process.env.TENANT_ISOLATION_MODE = 'strict';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, user: { id: 'user-a', tenant_ids: ['tenant-a'], kind: 'user' } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLAIM_REGISTRY_AUTH_PROVIDER;
    delete process.env.IAM_BASE_URL;
    delete process.env.TENANT_ISOLATION_MODE;
  });

  it('rejects requests without a bearer token', async () => {
    const { res, result } = response();
    await registryAuth(request(), res, vi.fn());
    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('uses IAM identity instead of spoofable user headers and preserves tenant context', async () => {
    const { res, result } = response();
    let nextCalled = false;
    await registryAuth(request({ authorization: 'Bearer caller-token', 'x-user-id': 'attacker', 'x-tenant-id': 'tenant-a' }), res, () => {
      nextCalled = true;
      expect(currentRegistryActor()).toEqual({ userId: 'user-a', tenantId: 'tenant-a', kind: 'user' });
    });
    expect(nextCalled).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('rejects a tenant outside the verified membership set', async () => {
    const { res, result } = response();
    await registryAuth(request({ authorization: 'Bearer caller-token', 'x-tenant-id': 'tenant-b' }), res, vi.fn());
    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('fails closed when strict mode has no verified tenant membership', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, user: { id: 'user-a', tenant_ids: [], kind: 'user' } }),
    }));
    const { res, result } = response();
    await registryAuth(request({ authorization: 'Bearer caller-token', 'x-tenant-id': 'tenant-a' }), res, vi.fn());
    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
