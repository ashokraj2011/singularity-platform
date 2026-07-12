/**
 * Caller identity context for inbox eligibility resolution.
 *
 * Shared by the runtime inbox (GET /runtime/inbox) and the approvals inbox
 * (GET /approvals/my-approvals) so both resolve TEAM_QUEUE / ROLE_BASED /
 * SKILL_BASED eligibility the same way — at read time, against IAM when
 * configured, falling back to the local mirror otherwise.
 *
 * Eligibility is resolved at read time (not stamped at creation) so users
 * newly added to a team / role / skill in IAM become eligible without a
 * backfill — see modules/task/lib/assignment.ts for the routing side.
 */

import { prisma } from '../prisma'
import { config } from '../../config'
import { getUserTeams, getUserSkills } from './client'
import { mapIamTeamIdsToLocal } from './teamMirror'

/** Cap IAM authzCheck calls per inbox request to bound the IAM RTT cost. */
export const ROLE_LOOKUP_BUDGET = 30

export type CallerContext = {
  userId:    string
  iamUserId: string | null
  teamIds:   string[]
  skillKeys: string[]
  roleKeys?: string[]
  source:    'local' | 'iam' | 'iam+local'
}

/**
 * Resolve the caller's identity context for inbox eligibility.
 *
 * Source-of-truth precedence:
 *   1. When AUTH_PROVIDER=iam AND IAM exposes the per-user endpoints
 *      (`/users/:id/teams`, `/users/:id/skills`), use IAM as the truth.
 *   2. Otherwise (or as fallback when IAM endpoints return empty/404), use
 *      the local mirror: `User.teamId` and joined `UserSkill` rows.
 *
 * `teamIds` is always returned as an array — IAM users can belong to many
 * teams; the local mirror has a single primary team.
 */
export async function loadCallerContext(userId: string): Promise<CallerContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, iamUserId: true, teamId: true, email: true, displayName: true,
      roles: { select: { role: { select: { name: true } } } },
      skills: { select: { skillId: true, skill: { select: { id: true, name: true } } } },
    },
  })
  if (!user) throw new Error('User not found')

  const localTeamIds   = user.teamId ? [user.teamId] : []
  // Route configs are human-authored and may use either the stable Skill id or
  // its key/name. Keep both in the local context so skill-based approvals do
  // not silently disappear from the approver inbox after a display-name edit.
  const localSkillKeys = [...new Set(user.skills.flatMap(us => [us.skill.id, us.skill.name]))]

  // Default: local mirror.  Override with IAM when configured and reachable.
  let teamIds   = localTeamIds
  let skillKeys = localSkillKeys
  const roleKeys  = user.roles.map(row => row.role.name)
  let source: 'local' | 'iam' | 'iam+local' = 'local'

  if (config.AUTH_PROVIDER === 'iam' && user.iamUserId) {
    try {
      const [iamTeams, iamSkills] = await Promise.all([
        getUserTeams(user.iamUserId).catch(() => [] as string[]),
        getUserSkills(user.iamUserId).catch(() => [] as string[]),
      ])

      // Use IAM data when present; otherwise (endpoint missing / empty array)
      // fall back to local for that dimension only.
      const usedIamTeams  = iamTeams.length  > 0
      const usedIamSkills = iamSkills.length > 0

      teamIds   = usedIamTeams  ? await mapIamTeamIdsToLocal(iamTeams) : localTeamIds
      skillKeys = usedIamSkills ? iamSkills : localSkillKeys

      if (usedIamTeams && usedIamSkills) source = 'iam'
      else if (usedIamTeams || usedIamSkills) source = 'iam+local'
    } catch {
      // IAM unreachable — stay on local. The middleware already enforces
      // valid tokens, so this branch is rare.
      source = 'local'
    }
  }

  return {
    userId:    user.id,
    iamUserId: user.iamUserId,
    teamIds,
    skillKeys,
    roleKeys,
    source,
  }
}
