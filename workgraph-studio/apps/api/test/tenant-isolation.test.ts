import { describe, expect, it } from 'vitest'
import {
  configuredTenantIdsForInternalToken,
  requireTenantFromRequest,
  requireTenantScopedInternalToken,
  resolveTenantFromContext,
  resolveTenantFromRequest,
  tenantIdForCreate,
} from '../src/lib/tenant-isolation'
import { config } from '../src/config'
import {
  configuredTenantIdsForServiceToken,
  validateIamServiceTokenTenantScope,
} from '../src/lib/iam/service-token'

function requestLike(input: {
  headers?: Record<string, string | undefined>
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}) {
  return {
    query: input.query ?? {},
    body: input.body ?? {},
    header(name: string) {
      return input.headers?.[name.toLowerCase()]
    },
  } as never
}

describe('tenant isolation helpers', () => {
  it('resolves tenant from the canonical workflow context locations', () => {
    expect(resolveTenantFromContext({ tenantId: 'tenant-a' })).toBe('tenant-a')
    expect(resolveTenantFromContext({ tenant_id: 'tenant-b' })).toBe('tenant-b')
    expect(resolveTenantFromContext({ _vars: { tenantId: 'tenant-c' } })).toBe('tenant-c')
    expect(resolveTenantFromContext({ _globals: { tenant_id: 'tenant-d' } })).toBe('tenant-d')
    expect(resolveTenantFromContext({ _workItem: { input: { tenantId: 'tenant-e' } } })).toBe('tenant-e')
  })

  it('uses the same resolver for newly-created workflow instance tenant ids', () => {
    expect(tenantIdForCreate({ _vars: { tenant_id: 'tenant-create' } })).toBe('tenant-create')
    expect(tenantIdForCreate({ _webhookPayload: { tenantId: 'nested-only' } })).toBeUndefined()
  })

  it('resolves request tenant from headers, query, then body', () => {
    expect(resolveTenantFromRequest(requestLike({ headers: { 'x-tenant-id': 'tenant-header' } }))).toBe('tenant-header')
    expect(resolveTenantFromRequest(requestLike({ headers: { 'x-singularity-tenant-id': 'tenant-singularity' } }))).toBe('tenant-singularity')
    expect(resolveTenantFromRequest(requestLike({ query: { tenant_id: 'tenant-query' } }))).toBe('tenant-query')
    expect(resolveTenantFromRequest(requestLike({ query: { tenantId: 'tenant-camel-query' } }))).toBe('tenant-camel-query')
    expect(resolveTenantFromRequest(requestLike({ body: { tenantId: 'tenant-body' } }))).toBe('tenant-body')
  })

  it('prefers explicit headers over weaker request locations', () => {
    expect(resolveTenantFromRequest(requestLike({
      headers: { 'x-tenant-id': 'tenant-header' },
      query: { tenant_id: 'tenant-query' },
      body: { tenantId: 'tenant-body' },
    }))).toBe('tenant-header')
  })

  it('requires an explicit request tenant only in strict mode', () => {
    const original = config.TENANT_ISOLATION_MODE
    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = 'off'
      expect(requireTenantFromRequest(requestLike({}), 'test surface')).toBeUndefined()

      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = 'strict'
      expect(() => requireTenantFromRequest(requestLike({}), 'test surface')).toThrow(/requires X-Tenant-Id/)
      expect(requireTenantFromRequest(requestLike({
        headers: { 'x-tenant-id': 'tenant-strict' },
      }), 'test surface')).toBe('tenant-strict')
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = original
    }
  })
})

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.')
}

describe('tenant-scoped IAM service tokens', () => {
  it('normalizes configured tenant ids', () => {
    const original = config.IAM_SERVICE_TOKEN_TENANT_IDS
    try {
      ;(config as { IAM_SERVICE_TOKEN_TENANT_IDS: string }).IAM_SERVICE_TOKEN_TENANT_IDS = ' tenant-b,tenant-a,tenant-a,, '
      expect(configuredTenantIdsForServiceToken()).toEqual(['tenant-a', 'tenant-b'])
    } finally {
      ;(config as { IAM_SERVICE_TOKEN_TENANT_IDS: string }).IAM_SERVICE_TOKEN_TENANT_IDS = original
    }
  })

  it('requires exact tenant_ids on service tokens in strict mode', () => {
    const originalMode = config.TENANT_ISOLATION_MODE
    const originalTenantIds = config.IAM_SERVICE_TOKEN_TENANT_IDS
    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict'; IAM_SERVICE_TOKEN_TENANT_IDS: string }).TENANT_ISOLATION_MODE = 'strict'
      ;(config as { IAM_SERVICE_TOKEN_TENANT_IDS: string }).IAM_SERVICE_TOKEN_TENANT_IDS = 'tenant-a,tenant-b'

      expect(validateIamServiceTokenTenantScope(unsignedJwt({ tenant_ids: ['tenant-b', 'tenant-a'] }))).toBe(true)
      expect(validateIamServiceTokenTenantScope(unsignedJwt({ tenant_ids: ['tenant-a'] }))).toBe(false)
      expect(validateIamServiceTokenTenantScope(unsignedJwt({ tenant_ids: ['tenant-a', 'tenant-b', 'tenant-c'] }))).toBe(false)
      expect(validateIamServiceTokenTenantScope(unsignedJwt({}))).toBe(false)
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = originalMode
      ;(config as { IAM_SERVICE_TOKEN_TENANT_IDS: string }).IAM_SERVICE_TOKEN_TENANT_IDS = originalTenantIds
    }
  })
})

describe('tenant-scoped Workgraph internal tokens', () => {
  it('normalizes configured internal token tenant ids', () => {
    const original = config.WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS
    try {
      ;(config as { WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: string }).WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS = ' tenant-z,tenant-a,tenant-z,, '
      expect(configuredTenantIdsForInternalToken()).toEqual(['tenant-a', 'tenant-z'])
    } finally {
      ;(config as { WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: string }).WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS = original
    }
  })

  it('requires tenant allowlist membership for internal tokens in strict mode', () => {
    const originalMode = config.TENANT_ISOLATION_MODE
    const originalTenantIds = config.WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS
    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict'; WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: string }).TENANT_ISOLATION_MODE = 'strict'
      ;(config as { WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: string }).WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS = 'tenant-a,tenant-b'

      expect(requireTenantScopedInternalToken(requestLike({
        headers: { 'x-tenant-id': 'tenant-a' },
      }), 'test internal surface')).toBe('tenant-a')
      expect(() => requireTenantScopedInternalToken(requestLike({}), 'test internal surface')).toThrow(/include X-Tenant-Id/)
      expect(() => requireTenantScopedInternalToken(requestLike({
        headers: { 'x-tenant-id': 'tenant-c' },
      }), 'test internal surface')).toThrow(/denied/)
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = originalMode
      ;(config as { WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS: string }).WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS = originalTenantIds
    }
  })
})
