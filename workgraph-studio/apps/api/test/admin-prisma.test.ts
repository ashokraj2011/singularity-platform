import { afterEach, describe, expect, it, vi } from 'vitest'

// RLS prep (slice 2) — adminPrisma must default to undefined (safe fallback to
// the regular tenant-scoped `prisma` client) when WORKGRAPH_DATABASE_URL_ADMIN
// isn't configured, and — when it IS configured — must be wired to THAT
// connection string, never silently reusing the app's normal DATABASE_URL
// (which would defeat the whole point: workgraph_app is deliberately
// NOSUPERUSER NOBYPASSRLS, so accidentally using it for the "admin" client
// would leave the cross-tenant discovery sweep just as RLS-blocked as before).
//
// Both config.ts and admin-prisma.ts read process.env at MODULE IMPORT time,
// so each case resets the module registry and re-imports fresh under the env
// it needs. PrismaClient is mocked so the "configured" case never attempts a
// real DB connection.

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
  vi.doUnmock('@prisma/client')
})

describe('lib/admin-prisma', () => {
  it('is undefined when WORKGRAPH_DATABASE_URL_ADMIN is not configured (safe default)', async () => {
    vi.resetModules()
    delete process.env.WORKGRAPH_DATABASE_URL_ADMIN
    const { adminPrisma } = await import('../src/lib/admin-prisma')
    expect(adminPrisma).toBeUndefined()
  })

  it('constructs a client scoped to WORKGRAPH_DATABASE_URL_ADMIN when configured — never the app DATABASE_URL', async () => {
    vi.resetModules()
    const adminUrl = 'postgresql://workgraph:workgraph_secret@wg-postgres:5432/workgraph'
    process.env.WORKGRAPH_DATABASE_URL_ADMIN = adminUrl
    process.env.DATABASE_URL = 'postgresql://workgraph_app:workgraph_app_secret@wg-postgres:5432/workgraph'

    const ctorCalls: unknown[] = []
    vi.doMock('@prisma/client', () => ({
      PrismaClient: class {
        constructor(opts: unknown) {
          ctorCalls.push(opts)
        }
      },
    }))

    const { adminPrisma } = await import('../src/lib/admin-prisma')
    expect(adminPrisma).toBeDefined()
    expect(ctorCalls).toHaveLength(1)
    expect(ctorCalls[0]).toMatchObject({ datasources: { db: { url: adminUrl } } })
  })
})
