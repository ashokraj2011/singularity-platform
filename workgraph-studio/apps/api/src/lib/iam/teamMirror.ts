import type { Team } from '@prisma/client'
import { prisma } from '../prisma'
import { config } from '../../config'
import { getUserTeams, proxyGet } from './client'

export type IamTeamRecord = {
  id: string
  team_key?: string | null
  name?: string | null
  description?: string | null
  bu_id?: string | null
}

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

export function tokenFromAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined
  return header.startsWith('Bearer ') ? header.slice(7) : header
}

function teamName(team: IamTeamRecord): string {
  return team.name?.trim() || team.team_key?.trim() || team.id
}

export async function listIamTeams(callerToken?: string): Promise<IamTeamRecord[]> {
  const body = await proxyGet('/teams', { page: 1, size: 200 }, callerToken)
  return unwrapItems<IamTeamRecord>(body).filter(t => typeof t.id === 'string' && t.id.length > 0)
}

export async function fetchIamTeam(teamId: string, callerToken?: string): Promise<IamTeamRecord | null> {
  const body = await proxyGet(`/teams/${encodeURIComponent(teamId)}`, {}, callerToken)
  if (!body || typeof body !== 'object') return null
  const row = body as IamTeamRecord
  return typeof row.id === 'string' ? row : null
}

export async function upsertIamTeamMirror(team: IamTeamRecord): Promise<Team> {
  const existing = await prisma.team.findFirst({
    where: {
      OR: [
        { externalIamTeamId: team.id },
        { id: team.id },
      ],
    },
  })

  const data = {
    name: teamName(team),
    description: team.description ?? undefined,
    externalIamTeamId: team.id,
    externalTeamKey: team.team_key ?? null,
    source: 'IAM',
  }

  if (existing) {
    return prisma.team.update({
      where: { id: existing.id },
      data,
    })
  }

  return prisma.team.create({
    data: {
      id: team.id,
      ...data,
    },
  })
}

export async function resolveTeamIdForWorkflow(teamId: string, callerToken?: string): Promise<string> {
  const existing = await prisma.team.findFirst({
    where: {
      OR: [
        { id: teamId },
        { externalIamTeamId: teamId },
      ],
    },
  })

  if (config.AUTH_PROVIDER !== 'iam') return existing?.id ?? teamId

  const iamTeam = await fetchIamTeam(teamId, callerToken).catch(() => null)
  if (iamTeam) {
    const mirrored = await upsertIamTeamMirror(iamTeam)
    return mirrored.id
  }

  if (existing) return existing.id
  throw new Error(`Team ${teamId} was not found in IAM or the Workgraph team mirror`)
}

export async function syncIamUserTeams(
  localUserId: string,
  iamUserId: string,
  callerToken?: string,
): Promise<{ iamTeamIds: string[]; localTeamIds: string[]; primaryTeamId: string | null }> {
  const iamTeamIds = await getUserTeams(iamUserId, callerToken).catch(() => [] as string[])
  const localTeamIds: string[] = []

  for (const iamTeamId of iamTeamIds) {
    try {
      const localTeamId = await resolveTeamIdForWorkflow(iamTeamId, callerToken)
      localTeamIds.push(localTeamId)
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: localTeamId, userId: localUserId } },
        update: {},
        create: { teamId: localTeamId, userId: localUserId },
      })
    } catch (err) {
      console.warn(`[iam-team-mirror] failed to mirror team ${iamTeamId}: ${(err as Error).message}`)
    }
  }

  const primaryTeamId = localTeamIds[0] ?? null
  if (primaryTeamId) {
    await prisma.user.update({
      where: { id: localUserId },
      data: { teamId: primaryTeamId },
    })
  }

  return { iamTeamIds, localTeamIds, primaryTeamId }
}

export async function mapIamTeamIdsToLocal(iamTeamIds: string[], callerToken?: string): Promise<string[]> {
  const localIds: string[] = []
  for (const id of iamTeamIds) {
    try {
      localIds.push(await resolveTeamIdForWorkflow(id, callerToken))
    } catch {
      localIds.push(id)
    }
  }
  return Array.from(new Set(localIds))
}
