export type ObjectiveCoverageInput = {
  id: string
  title: string
  status: string
  valueScore: number
}

export type RequirementCoverageInput = {
  id: string
  statement: string
  priority: 'MUST' | 'SHOULD' | 'MAY'
  objectiveRefs: string[]
}

export type CoverageIssue = {
  code: 'ACTIVE_OBJECTIVE_UNSERVED' | 'REQUIREMENT_WITHOUT_OBJECTIVE' | 'UNKNOWN_OBJECTIVE_REFERENCE'
  severity: 'warning' | 'error'
  entityType: 'objective' | 'requirement'
  entityId: string
  message: string
}

export function detectObjectiveCoverage(
  objectives: ObjectiveCoverageInput[],
  requirements: RequirementCoverageInput[],
  mode: 'hub' | 'lock' | 'portfolio' = 'hub',
) {
  const objectiveById = new Map(objectives.map(objective => [objective.id, objective]))
  const coveredObjectiveIds = new Set(requirements.flatMap(requirement => requirement.objectiveRefs))
  const issues: CoverageIssue[] = []

  for (const objective of objectives) {
    if (objective.status !== 'ACTIVE' || coveredObjectiveIds.has(objective.id)) continue
    issues.push({
      code: 'ACTIVE_OBJECTIVE_UNSERVED',
      severity: mode === 'portfolio' ? 'error' : 'warning',
      entityType: 'objective',
      entityId: objective.id,
      message: `Active objective "${objective.title}" is not served by any requirement`,
    })
  }

  for (const requirement of requirements) {
    if (!requirement.objectiveRefs.length) {
      issues.push({
        code: 'REQUIREMENT_WITHOUT_OBJECTIVE',
        severity: requirement.priority === 'MUST' ? 'error' : 'warning',
        entityType: 'requirement',
        entityId: requirement.id,
        message: `${requirement.priority} requirement ${requirement.id} has no funded business objective`,
      })
      continue
    }
    for (const objectiveId of requirement.objectiveRefs) {
      if (objectiveById.has(objectiveId)) continue
      issues.push({
        code: 'UNKNOWN_OBJECTIVE_REFERENCE',
        severity: 'error',
        entityType: 'requirement',
        entityId: requirement.id,
        message: `Requirement ${requirement.id} references unavailable objective ${objectiveId}`,
      })
    }
  }

  return {
    issues,
    errors: issues.filter(issue => issue.severity === 'error'),
    warnings: issues.filter(issue => issue.severity === 'warning'),
    coveredObjectiveIds: [...coveredObjectiveIds].filter(id => objectiveById.has(id)),
    objectiveCount: objectives.length,
    requirementCount: requirements.length,
    coveragePercent: objectives.length
      ? Math.round(objectives.filter(objective => coveredObjectiveIds.has(objective.id)).length / objectives.length * 100)
      : 100,
  }
}

export function maxObjectiveValueScore(objectiveRefs: string[], valueByObjectiveId: Map<string, number>): number {
  return objectiveRefs.reduce((maximum, id) => Math.max(maximum, valueByObjectiveId.get(id) ?? 0), 0)
}

export function deriveMilestoneStatus(input: {
  targetDate: Date
  projectedFinishAt?: Date | null
  completed: number
  total: number
  now?: Date
}): 'PLANNED' | 'AT_RISK' | 'LATE' | 'DELIVERED' {
  if (input.total > 0 && input.completed >= input.total) return 'DELIVERED'
  const now = input.now ?? new Date()
  if (input.targetDate.getTime() < now.getTime()) return 'LATE'
  if (input.projectedFinishAt && input.projectedFinishAt.getTime() > input.targetDate.getTime()) return 'AT_RISK'
  return 'PLANNED'
}

export function buildValueDeliveredCurve(rows: Array<{
  rowKey: string
  projectedFinishAt: Date | null
  objectiveValueScore: number
}>) {
  let cumulativeValue = 0
  return rows
    .filter(row => row.projectedFinishAt)
    .sort((left, right) => left.projectedFinishAt!.getTime() - right.projectedFinishAt!.getTime()
      || right.objectiveValueScore - left.objectiveValueScore
      || left.rowKey.localeCompare(right.rowKey))
    .map(row => {
      cumulativeValue += Math.max(0, row.objectiveValueScore)
      return {
        rowKey: row.rowKey,
        date: row.projectedFinishAt!.toISOString(),
        value: row.objectiveValueScore,
        cumulativeValue,
      }
    })
}

export function previousCompleteUtcWeek(now = new Date()): { periodStart: Date; periodEnd: Date } {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7
  const currentWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday))
  return {
    periodStart: new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000),
    periodEnd: currentWeekStart,
  }
}

export type RequirementDelta = { added: string[]; changed: string[]; removed: string[] }

export function diffRequirements<T extends { id: string }>(previous: T[], current: T[]): RequirementDelta {
  const previousById = new Map(previous.map(requirement => [requirement.id, requirement]))
  const currentById = new Map(current.map(requirement => [requirement.id, requirement]))
  return {
    added: current.filter(requirement => !previousById.has(requirement.id)).map(requirement => requirement.id),
    removed: previous.filter(requirement => !currentById.has(requirement.id)).map(requirement => requirement.id),
    changed: current.filter(requirement => {
      const prior = previousById.get(requirement.id)
      return prior && JSON.stringify(prior) !== JSON.stringify(requirement)
    }).map(requirement => requirement.id),
  }
}

export function uncoveredRequirementDelta(actual: RequirementDelta, declared: Partial<RequirementDelta>): string[] {
  const missing = (kind: keyof RequirementDelta) => actual[kind].filter(id => !(declared[kind] ?? []).includes(id))
  return [...new Set([...missing('added'), ...missing('changed'), ...missing('removed')])]
}
