import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { listRuntimeCapabilities } from '../../lib/agent-and-tools/client'
import { proxyGet } from '../../lib/iam/client'
import { listIamTeams, tokenFromAuthorizationHeader, type IamTeamRecord } from '../../lib/iam/teamMirror'

export const identitySyncRouter: Router = Router()

function unwrapItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
    if (Array.isArray(obj.content)) return obj.content as T[]
  }
  return []
}

type IamCapabilityRecord = {
  id?: string
  capability_id?: string
  name?: string
  metadata?: Record<string, unknown>
}

async function listIamCapabilities(callerToken?: string): Promise<IamCapabilityRecord[]> {
  const body = await proxyGet('/capabilities', { page: 1, size: 200 }, callerToken)
  return unwrapItems<IamCapabilityRecord>(body)
}

async function capabilityMembers(capability: IamCapabilityRecord, callerToken?: string): Promise<unknown[]> {
  const key = capability.capability_id ?? capability.id
  if (!key) return []
  const body = await proxyGet(`/capabilities/${encodeURIComponent(key)}/members`, {}, callerToken)
    .catch(() => [] as unknown[])
  return Array.isArray(body) ? body : unwrapItems<unknown>(body)
}

identitySyncRouter.get('/sync-report', async (req, res, next) => {
  try {
    const callerToken = tokenFromAuthorizationHeader(req.headers.authorization)
    const [iamTeams, localTeams, iamCapabilities, runtimeCapabilities] = await Promise.all([
      listIamTeams(callerToken),
      prisma.team.findMany({ orderBy: { name: 'asc' } }),
      listIamCapabilities(callerToken),
      listRuntimeCapabilities(req.headers.authorization).catch(() => []),
    ])

    const iamTeamIds = new Set(iamTeams.map(t => t.id))
    const mirroredIamTeamIds = new Set(
      localTeams
        .map(t => t.externalIamTeamId ?? (t.source === 'IAM' ? t.id : null))
        .filter((id): id is string => Boolean(id)),
    )

    const iamTeamsNotMirrored = iamTeams.filter(t => !mirroredIamTeamIds.has(t.id))
    const localTeamsNotBackedByIam = localTeams.filter(t => t.source !== 'IAM' && !t.externalIamTeamId)
    const iamMirrorsMissingUpstream = localTeams.filter(t => {
      const externalId = t.externalIamTeamId ?? (t.source === 'IAM' ? t.id : null)
      return Boolean(externalId && !iamTeamIds.has(externalId))
    })

    const iamCapabilityKeys = new Set<string>()
    for (const cap of iamCapabilities) {
      if (cap.id) iamCapabilityKeys.add(cap.id)
      if (cap.capability_id) iamCapabilityKeys.add(cap.capability_id)
      const runtimeId = cap.metadata?.agentRuntimeCapabilityId
      if (typeof runtimeId === 'string') iamCapabilityKeys.add(runtimeId)
    }

    const runtimeCapabilitiesMissingIamReference = runtimeCapabilities.filter(cap => !iamCapabilityKeys.has(cap.id))

    const iamCapabilitiesWithoutMemberships = []
    for (const cap of iamCapabilities) {
      const members = await capabilityMembers(cap, callerToken)
      if (members.length === 0) iamCapabilitiesWithoutMemberships.push(cap)
    }

    res.json({
      generatedAt: new Date().toISOString(),
      teams: {
        iamTotal: iamTeams.length,
        workgraphTotal: localTeams.length,
        iamTeamsNotMirrored,
        localTeamsNotBackedByIam,
        iamMirrorsMissingUpstream,
      },
      capabilities: {
        iamTotal: iamCapabilities.length,
        agentRuntimeTotal: runtimeCapabilities.length,
        runtimeCapabilitiesMissingIamReference,
        iamCapabilitiesWithoutMemberships,
      },
    })
  } catch (err) {
    next(err)
  }
})
