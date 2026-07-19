/**
 * Synthesis Studio — context reference resolver (R1A 1.3). Turns a typed @-ref into a
 * resolved snapshot: existence + label + (versionId, contentHash) for pinning + a coarse
 * classification + an authz note. Composes the existing cross-service resolver for
 * federated kinds (CLAIM → claim-registry, PERSON → IAM) and tenant-scoped local reads
 * for studio-owned kinds. Kinds without a first-class model yet (REQUIREMENT/SOURCE/
 * METRIC/OUTCOME) resolve as stored-but-unresolved so the manifest can flag them.
 */
import type { Request } from 'express'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { resolveOne } from '../lookup/resolver'
import type { ResolvedRefSnapshot } from './context-manifest'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID

// Synthesis entityType → the lookup resolver's federated kind, where one exists.
const FEDERATED: Record<string, string> = { CLAIM: 'claim', PERSON: 'user' }

export interface ContextRefInput {
  entityType: string
  entityId: string
  referenceMode?: 'FOLLOW_LATEST' | 'PINNED'
  versionId?: string | null
  contentHash?: string | null
}

export async function resolveContextRef(ref: ContextRefInput, req: Request): Promise<ResolvedRefSnapshot> {
  const referenceMode = ref.referenceMode ?? 'FOLLOW_LATEST'
  const base = { entityType: ref.entityType, entityId: ref.entityId, referenceMode }

  // Federated: reuse the cross-service resolver (auth bearer forwarded, fail-closed).
  const federatedKind = FEDERATED[ref.entityType]
  if (federatedKind) {
    const hit = await resolveOne(federatedKind, ref.entityId, req)
    const versionId = ref.versionId ?? null
    const contentHash = ref.contentHash ?? null
    return {
      ...base, exists: hit.exists, label: hit.label,
      versionId, contentHash, classification: null,
      pinnable: Boolean(versionId && contentHash), error: hit.error,
    }
  }

  // Local studio kinds — tenant-scoped reads (a cross-tenant id resolves as not-found).
  const tid = tenantId()
  switch (ref.entityType) {
    case 'SPECIFICATION': {
      const sv = await prisma.specificationVersion.findFirst({
        where: { id: ref.entityId, tenantId: tid },
        select: { id: true, version: true, status: true, contentHash: true },
      })
      return sv
        ? { ...base, exists: true, label: `Spec v${sv.version} (${sv.status})`, versionId: String(sv.version), contentHash: sv.contentHash, classification: 'internal', pinnable: Boolean(sv.contentHash) }
        : { ...base, exists: false, pinnable: false }
    }
    case 'WORKITEM': {
      const wi = await prisma.workItem.findFirst({
        where: { id: ref.entityId, tenantId: tid },
        select: { id: true, workCode: true, status: true },
      })
      return wi
        ? { ...base, exists: true, label: `${wi.workCode} (${wi.status})`, versionId: null, contentHash: null, classification: 'internal', pinnable: false }
        : { ...base, exists: false, pinnable: false }
    }
    case 'DECISION': {
      const d = await prisma.decisionDossier.findFirst({
        where: { id: ref.entityId, tenantId: tid },
        select: { id: true, title: true, status: true, revision: true },
      })
      return d
        ? { ...base, exists: true, label: `${d.title} (${d.status})`, versionId: String(d.revision), contentHash: null, classification: 'internal', pinnable: false }
        : { ...base, exists: false, pinnable: false }
    }
    default:
      // REQUIREMENT (JSON in spec packages), SOURCE, METRIC, OUTCOME — no first-class model yet.
      return { ...base, exists: false, pinnable: false, error: `resolution not yet supported for ${ref.entityType}` }
  }
}
