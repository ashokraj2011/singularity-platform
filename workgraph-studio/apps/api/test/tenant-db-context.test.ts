import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config'
import { prisma as routedPrisma } from '../src/lib/prisma'
import {
  currentTenantIdForDb,
  runWithTenantDbContext,
  withTenantDbTransaction,
} from '../src/lib/tenant-db-context'

describe('tenant DB context', () => {
  it('keeps tenant ids scoped to the async request context', async () => {
    expect(currentTenantIdForDb()).toBeUndefined()

    const observed = await runWithTenantDbContext('tenant-request', async () => {
      await Promise.resolve()
      return currentTenantIdForDb()
    })

    expect(observed).toBe('tenant-request')
    expect(currentTenantIdForDb()).toBeUndefined()
  })

  it('sets app.tenant_id transaction-locally before tenant-scoped DB work', async () => {
    const originalMode = config.TENANT_ISOLATION_MODE
    const executeCalls: unknown[] = []
    const tx = {
      $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        executeCalls.push({ strings: [...strings], values })
        return Promise.resolve(1)
      },
    }
    const prisma = {
      $transaction(callback: (client: typeof tx) => Promise<string>) {
        return callback(tx)
      },
    }

    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = 'strict'
      const result = await runWithTenantDbContext('tenant-db', () => (
        withTenantDbTransaction(prisma as never, async () => 'done')
      ))

      expect(result).toBe('done')
      expect(executeCalls).toEqual([
        {
          strings: ["select set_config('app.tenant_id', ", ', true)'],
          values: ['tenant-db'],
        },
      ])
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = originalMode
    }
  })

  it('routes the shared prisma export through the active transaction client', async () => {
    const originalMode = config.TENANT_ISOLATION_MODE
    const findMany = vi.fn().mockResolvedValue([{ id: 'visible-through-tx' }])
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      workflowInstance: { findMany },
    }
    const prisma = {
      $transaction(callback: (client: typeof tx) => Promise<unknown>) {
        return callback(tx)
      },
    }

    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = 'strict'
      const rows = await runWithTenantDbContext('tenant-proxy', () => (
        withTenantDbTransaction(prisma as never, async () => (
          routedPrisma.workflowInstance.findMany({ where: { tenantId: 'tenant-proxy' } })
        ))
      ))

      expect(rows).toEqual([{ id: 'visible-through-tx' }])
      expect(findMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-proxy' } })
      expect(tx.$executeRaw).toHaveBeenCalledOnce()
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = originalMode
    }
  })

  it('fails closed in strict mode when DB work has no tenant context', async () => {
    const originalMode = config.TENANT_ISOLATION_MODE
    const prisma = {
      $transaction(callback: (client: { $executeRaw: () => Promise<number> }) => Promise<string>) {
        return callback({ $executeRaw: () => Promise.resolve(1) })
      },
    }

    try {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = 'strict'
      await expect(withTenantDbTransaction(prisma as never, async () => 'done')).rejects.toThrow(/requires tenant context/)
    } finally {
      ;(config as { TENANT_ISOLATION_MODE: 'off' | 'strict' }).TENANT_ISOLATION_MODE = originalMode
    }
  })
})
