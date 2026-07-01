import { PrismaClient } from '@prisma/client'
import { config } from '../config'

/**
 * RLS prep — the owner/admin DB connection, used ONLY for TimerSweep's one
 * cross-tenant discovery read (finding due TIMER nodes across every tenant in
 * a single query — inherently not scopeable to one tenant's transaction, since
 * that's what a sweep is). `bootstrap-app-role.sh` already provisions this
 * connection specifically "for Prisma migrations and RLS cutovers"; the app's
 * normal `prisma` export connects as `workgraph_app` (NOSUPERUSER NOBYPASSRLS
 * — genuinely RLS-bound), which cannot see across tenants once FORCE ROW LEVEL
 * SECURITY is enabled.
 *
 * Discipline, not a DB-level guarantee: this client is only ever used for a
 * read-only `findMany`. Nothing else in the app should import it — every
 * per-item write after the sweep still goes through the regular tenant-scoped
 * `prisma` + `withTenantDbTransaction`, using the tenantId the sweep already
 * has in hand from the eager-loaded `instance` relation.
 *
 * `WORKGRAPH_DATABASE_URL_ADMIN` is optional (most dev/test setups won't set
 * it) — callers must fall back to the regular `prisma` client when this is
 * undefined, which is today's exact (pre-RLS-prep) behavior.
 */
export const adminPrisma: PrismaClient | undefined = config.WORKGRAPH_DATABASE_URL_ADMIN
  ? new PrismaClient({
      datasources: { db: { url: config.WORKGRAPH_DATABASE_URL_ADMIN } },
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    })
  : undefined
