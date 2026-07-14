/**
 * Project-specification service — read and section-patch a Specification Project's shared upstream
 * (analysis + design). One package per project; a revision counter powers optimistic-concurrency
 * patches so two editors can't silently clobber each other (mirrors the Work Item spec editor).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent } from '../../lib/audit'
import { ConflictError } from '../../lib/errors'
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

export interface PatchSectionInput {
  section: ProjectSpecSection
  value: unknown
  expectedRevision: number
}

export async function patchProjectSpecSection(projectId: string, input: PatchSectionInput, userId: string): Promise<ProjectSpecView> {
  const validated = projectSpecSectionSchemas[input.section].parse(input.value)
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
