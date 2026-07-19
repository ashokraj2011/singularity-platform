/**
 * Project-specification service — read and section-patch a Specification Project's shared upstream
 * (analysis + design). One package per project; a revision counter powers optimistic-concurrency
 * patches so two editors can't silently clobber each other (mirrors the Work Item spec editor).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent } from '../../lib/audit'
import { ConflictError, ValidationError } from '../../lib/errors'
import { getProject } from './studio-projects.service'
import {
  projectSpecPackageSchema,
  projectSpecSectionSchemas,
  type ProjectSpecSection,
  type ProjectSpecPackage,
} from './studio-spec.schemas'

export interface ProjectSpecView {
  projectId: string
  revision: number
  package: ProjectSpecPackage
  updatedAt: Date
}

// Always normalize the stored JSON through the schema so missing sections fill with defaults.
function normalize(pkg: unknown): ProjectSpecPackage {
  return projectSpecPackageSchema.parse(pkg ?? {})
}

export async function getProjectSpec(projectId: string): Promise<ProjectSpecView> {
  await getProject(projectId) // 404s if the project doesn't exist / isn't visible to the tenant
  const existing = await prisma.projectSpecification.findUnique({ where: { projectId } })
  if (existing) {
    return { projectId, revision: existing.revision, package: normalize(existing.package), updatedAt: existing.updatedAt }
  }
  const created = await prisma.projectSpecification.create({
    data: {
      projectId,
      package: normalize({}) as unknown as Prisma.InputJsonValue,
      tenantId: currentTenantIdForDb() ?? undefined,
    },
  })
  return { projectId, revision: created.revision, package: normalize(created.package), updatedAt: created.updatedAt }
}


/**
 * Reject a requirements section that references objectives which do not exist.
 *
 * detectObjectiveCoverage already reports dangling refs -- as an ERROR that gates
 * spec lock -- but only at READ time. So a package saved with a bad ref lands
 * happily and nothing objects until someone opens coverage or attempts a lock, by
 * which point whoever made the edit has moved on and the failure looks like a
 * lock problem rather than a bad reference.
 *
 * Checking here moves the error to the edit that caused it. Read-time detection
 * stays exactly as it is: this narrows what can be written, it does not change
 * how existing rows are judged, so packages already carrying a dangling ref keep
 * reporting UNKNOWN_OBJECTIVE_REFERENCE rather than becoming unopenable.
 *
 * Refs are checked against objectives visible to THIS project -- either owned by
 * it or linked through BusinessObjectiveProject -- so a requirement cannot be
 * justified by another project's objective.
 */
async function assertObjectiveRefsResolve(projectId: string, requirements: Array<{ id: string; objectiveRefs: string[] }>): Promise<void> {
  const referenced = [...new Set(requirements.flatMap(requirement => requirement.objectiveRefs))]
  if (referenced.length === 0) return

  const visible = await prisma.businessObjective.findMany({
    where: {
      id: { in: referenced },
      OR: [{ studioProjectId: projectId }, { projectLinks: { some: { projectId } } }],
    },
    select: { id: true },
  })
  const known = new Set(visible.map(objective => objective.id))
  const dangling = requirements
    .flatMap(requirement => requirement.objectiveRefs.map(ref => ({ requirementId: requirement.id, ref })))
    .filter(entry => !known.has(entry.ref))
  if (dangling.length === 0) return

  // Name the requirement as well as the id: "objective X is unknown" is not
  // actionable when 40 requirements are being saved at once.
  const detail = dangling.map(entry => `${entry.requirementId} -> ${entry.ref}`).join(', ')
  throw new ValidationError(
    `${dangling.length} requirement objective reference(s) do not resolve to an objective on this project: ${detail}. `
    + 'Link the objective to this project, or remove the reference.',
  )
}

export interface PatchSectionInput {
  section: ProjectSpecSection
  value: unknown
  expectedRevision: number
}

export async function patchProjectSpecSection(projectId: string, input: PatchSectionInput, userId: string): Promise<ProjectSpecView> {
  const validated = projectSpecSectionSchemas[input.section].parse(input.value)
  if (input.section === 'requirements') {
    await assertObjectiveRefsResolve(projectId, validated as Array<{ id: string; objectiveRefs: string[] }>)
  }
  const current = await getProjectSpec(projectId)
  if (input.expectedRevision !== current.revision) {
    throw new ConflictError(`This project spec changed since you loaded it (expected r${input.expectedRevision}, now r${current.revision}). Reload and reapply.`)
  }
  const nextPackage = { ...current.package, [input.section]: validated }
  const updated = await prisma.projectSpecification.update({
    where: { projectId },
    data: {
      package: nextPackage as unknown as Prisma.InputJsonValue,
      revision: { increment: 1 },
      updatedById: userId,
    },
  })
  await logEvent('ProjectSpecificationSectionUpdated', 'SpecificationProject', projectId, userId)
  return { projectId, revision: updated.revision, package: normalize(updated.package), updatedAt: updated.updatedAt }
}
