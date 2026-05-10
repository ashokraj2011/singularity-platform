/**
 * Clone a template's design instance into a fresh run.
 *
 * Reads the design instance's phases, nodes, and edges; writes new rows under
 * a new WorkflowInstance with regenerated ids.  Carries node `config` verbatim
 * (assignmentMode, formSections, branches, retry policy, etc.) so the run
 * inherits everything the designer set up.  Does not carry runtime state —
 * status resets to PENDING, transient `_attempts`/`_lastError` keys are
 * stripped, and `completed_joins` (parallel-join counter) is reset.
 *
 * Variable hydration:
 *   _globals  ← Team variables (GLOBAL: team default; INSTANCE: caller override or team default)
 *   _vars     ← Template variable defaults, then caller `vars` overrides
 *
 * Permission, audit, and outbox are the caller's responsibility.
 */

import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma'

export type CloneOpts = {
  templateId:      string
  name?:           string                    // optional run name
  vars?:           Record<string, unknown>   // override template variable defaults
  globals?:        Record<string, unknown>   // override INSTANCE-scoped team globals
  createdById?:    string
  initiativeId?:   string
}

export type CloneResult = {
  instance: { id: string; name: string; status: string; templateVersion: number | null }
  cloned:   { phases: number; nodes: number; edges: number }
  /** Version this run was pinned to (the snapshot it cloned from). */
  pinnedToVersion: number | null
  /** True if this run created a new template version; false if it reused an existing snapshot. */
  newVersionCreated: boolean
}

type TemplateVarDef = {
  key: string; type?: string; defaultValue?: unknown; scope?: string;
}

// Strip transient runtime-only keys from a node's config blob.
function sanitizeNodeConfig(raw: unknown): Prisma.InputJsonValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as Prisma.InputJsonValue
  const cfg = { ...(raw as Record<string, unknown>) }
  delete cfg._attempts
  delete cfg._lastError
  delete cfg.completed_joins   // parallel-join counter — reset per run
  delete cfg._items            // FOREACH iteration state
  delete cfg._completed        // FOREACH completion counter
  return cfg as Prisma.InputJsonValue
}

// ── Snapshot building + content hashing ─────────────────────────────────────

type DesignWithGraph = {
  id: string
  phases: Array<{ id: string; name: string; displayOrder: number; color: string | null }>
  nodes:  Array<{ id: string; phaseId: string | null; nodeType: any; label: string;
                  config: unknown; compensationConfig: unknown; executionLocation: any;
                  positionX: number; positionY: number }>
  edges:  Array<{ id: string; sourceNodeId: string; targetNodeId: string;
                  edgeType: any; condition: unknown; label: string | null }>
}

/**
 * Build a deterministic snapshot blob from the design's relational rows.
 * Order is canonicalized so the contentHash only changes when the user
 * actually changed something semantic.
 */
function buildSnapshot(design: DesignWithGraph): {
  snapshot: Record<string, unknown>
  hash:     string
} {
  // Sort phases / nodes / edges to make the hash stable regardless of
  // database row insertion order.
  const phases = [...design.phases]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
    .map(p => ({ id: p.id, name: p.name, displayOrder: p.displayOrder, color: p.color }))

  const nodes = [...design.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(n => ({
      id: n.id, phaseId: n.phaseId, nodeType: n.nodeType, label: n.label,
      config: sanitizeNodeConfig(n.config),
      compensationConfig: n.compensationConfig ?? null,
      executionLocation: n.executionLocation,
      positionX: n.positionX, positionY: n.positionY,
    }))

  const edges = [...design.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(e => ({
      id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
      edgeType: e.edgeType, condition: e.condition ?? null, label: e.label ?? null,
    }))

  const snapshot = { phases, nodes, edges }
  // Stable JSON — Object.keys order is preserved by Node's JSON.stringify.
  const json = JSON.stringify(snapshot)
  const hash = createHash('sha256').update(json).digest('hex')
  return { snapshot, hash }
}

/**
 * Find an existing version with the same contentHash, or create a new one.
 * Bumps `template.currentVersion` only when a new row is inserted.
 *
 * Runs inside a Prisma transaction client when called from the cloning path.
 */
async function ensureVersionForDesign(
  templateId: string,
  design: DesignWithGraph,
  source: 'auto' | 'manual',
): Promise<{ version: number; created: boolean }> {
  const { snapshot, hash } = buildSnapshot(design)

  const existing = await prisma.workflowVersion.findFirst({
    where:  { templateId, contentHash: hash },
    select: { version: true },
  })
  if (existing) return { version: existing.version, created: false }

  const template = await prisma.workflow.findUniqueOrThrow({
    where:  { id: templateId },
    select: { currentVersion: true },
  })
  const nextVersion = template.currentVersion + 1

  await prisma.$transaction([
    prisma.workflowVersion.create({
      data: {
        templateId,
        version:       nextVersion,
        graphSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        contentHash:   hash,
        source,
      },
    }),
    prisma.workflow.update({
      where: { id: templateId },
      data:  { currentVersion: nextVersion },
    }),
  ])

  return { version: nextVersion, created: true }
}

export async function cloneDesignToRun(opts: CloneOpts): Promise<CloneResult> {
  const { templateId } = opts

  // ── 1. Load the workflow + its design graph from the dedicated design tables
  const workflow = await prisma.workflow.findUnique({
    where:  { id: templateId },
    select: { id: true, teamId: true, variables: true, name: true, capabilityId: true },
  })
  if (!workflow) throw new Error(`Workflow ${templateId} not found`)

  const [designPhases, designNodes, designEdges] = await Promise.all([
    prisma.workflowDesignPhase.findMany({ where: { workflowId: templateId }, orderBy: { displayOrder: 'asc' } }),
    prisma.workflowDesignNode.findMany ({ where: { workflowId: templateId }, orderBy: { createdAt: 'asc' } }),
    prisma.workflowDesignEdge.findMany ({ where: { workflowId: templateId }, orderBy: { createdAt: 'asc' } }),
  ])

  const design: DesignWithGraph = {
    id:     templateId,
    phases: designPhases.map(p => ({ id: p.id, name: p.name, displayOrder: p.displayOrder, color: p.color })),
    nodes:  designNodes.map(n => ({
      id: n.id, phaseId: n.phaseId, nodeType: n.nodeType, label: n.label,
      config: n.config, compensationConfig: n.compensationConfig,
      executionLocation: n.executionLocation, positionX: n.positionX, positionY: n.positionY,
    })),
    edges:  designEdges.map(e => ({
      id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
      edgeType: e.edgeType, condition: e.condition, label: e.label,
    })),
  }

  // Alias used below for context hydration / naming.
  const template = workflow

  const teamVars = await prisma.teamVariable.findMany({
    where:  { teamId: template.teamId },
    select: { key: true, value: true, scope: true, visibility: true, visibilityScopeId: true },
  })
  const globalsOverrides = opts.globals ?? {}
  // Apply visibility filter in cascading order so a CAPABILITY-scoped override
  // beats an ORG_GLOBAL one with the same key, and WORKFLOW beats CAPABILITY.
  const visibleVars = [
    ...teamVars.filter(v => v.visibility === 'ORG_GLOBAL'),
    ...teamVars.filter(v => v.visibility === 'CAPABILITY' && v.visibilityScopeId === template.capabilityId),
    ...teamVars.filter(v => v.visibility === 'WORKFLOW'   && v.visibilityScopeId === template.id),
  ]
  const globals: Record<string, unknown> = {}
  for (const v of visibleVars) {
    if (v.scope === 'INSTANCE' && globalsOverrides[v.key] !== undefined) {
      globals[v.key] = globalsOverrides[v.key]
    } else {
      globals[v.key] = v.value
    }
  }

  const varDefs: TemplateVarDef[] = Array.isArray(template.variables)
    ? (template.variables as unknown as TemplateVarDef[])
    : []
  const varsOverrides = opts.vars ?? {}
  const vars: Record<string, unknown> = {}
  for (const d of varDefs) {
    if (varsOverrides[d.key] !== undefined) vars[d.key] = varsOverrides[d.key]
    else if (d.defaultValue !== undefined)  vars[d.key] = d.defaultValue
  }
  for (const [k, v] of Object.entries(varsOverrides)) if (!(k in vars)) vars[k] = v

  const initialContext: Record<string, unknown> = {}
  if (Object.keys(globals).length > 0) initialContext._globals = globals
  if (Object.keys(vars).length    > 0) initialContext._vars    = vars

  // ── 3. Compute the next run number for naming ─────────────────────────────
  const runCount = await prisma.workflowInstance.count({
    where: { templateId },
  })
  const runName = opts.name ?? `${template.name} · Run #${runCount + 1}`

  // ── 3b. Snapshot the design graph and pin a version (deduped by content) ──
  // We do this *before* the transaction because creating a snapshot may itself
  // bump `template.currentVersion`; we want that committed regardless of run
  // outcome so identical clones in parallel still see the same version.
  const versionResult = await ensureVersionForDesign(templateId, design, 'auto')

  // ── 4. Clone everything in a single transaction ───────────────────────────
  return await prisma.$transaction<CloneResult>(async (tx) => {
    // 4a. Create the run instance row, pinned to the design version we just snapshotted
    const run = await tx.workflowInstance.create({
      data: {
        templateId,
        templateVersion: versionResult.version,
        name:        runName,
        status:      'DRAFT',
        context:     initialContext as Prisma.InputJsonValue,
        createdById: opts.createdById,
        initiativeId: opts.initiativeId,
      },
    })

    // 4b. Phases (id-mapped)
    const phaseIdMap = new Map<string, string>()
    for (const p of design.phases) {
      const np = await tx.workflowPhase.create({
        data: {
          instanceId:   run.id,
          name:         p.name,
          displayOrder: p.displayOrder,
          color:        p.color,
        },
      })
      phaseIdMap.set(p.id, np.id)
    }

    // 4c. Nodes (id-mapped, status reset, config sanitized)
    const nodeIdMap = new Map<string, string>()
    for (const n of design.nodes) {
      const nn = await tx.workflowNode.create({
        data: {
          instanceId:         run.id,
          phaseId:            n.phaseId ? phaseIdMap.get(n.phaseId) ?? null : null,
          nodeType:           n.nodeType,
          label:              n.label,
          status:             'PENDING',
          config:             sanitizeNodeConfig(n.config),
          compensationConfig: (n.compensationConfig ?? undefined) as Prisma.InputJsonValue | undefined,
          executionLocation:  n.executionLocation,
          positionX:          n.positionX,
          positionY:          n.positionY,
        },
      })
      nodeIdMap.set(n.id, nn.id)
    }

    // 4d. Edges (sourceNodeId / targetNodeId remapped via nodeIdMap)
    let edgeCount = 0
    for (const e of design.edges) {
      const newSource = nodeIdMap.get(e.sourceNodeId)
      const newTarget = nodeIdMap.get(e.targetNodeId)
      if (!newSource || !newTarget) {
        // Skip orphaned edges — shouldn't happen, but defend against bad data
        continue
      }
      await tx.workflowEdge.create({
        data: {
          instanceId:   run.id,
          sourceNodeId: newSource,
          targetNodeId: newTarget,
          edgeType:     e.edgeType,
          condition:    (e.condition ?? undefined) as Prisma.InputJsonValue | undefined,
          label:        e.label,
        },
      })
      edgeCount++
    }

    return {
      instance: {
        id:              run.id,
        name:            run.name,
        status:          run.status,
        templateVersion: run.templateVersion ?? null,
      },
      cloned:           { phases: phaseIdMap.size, nodes: nodeIdMap.size, edges: edgeCount },
      pinnedToVersion:  versionResult.version,
      newVersionCreated: versionResult.created,
    }
  })
}

/**
 * Back-compat shim: previous codepaths returned a "design instance id" so the
 * studio could open `/workflow/:instanceId` for editing.  After the refactor
 * the design lives directly on the Workflow row, so we return the workflow id
 * itself — the studio resolves design vs run via a separate URL prefix.
 */
export async function getDesignInstanceId(templateId: string): Promise<string | null> {
  const w = await prisma.workflow.findUnique({ where: { id: templateId }, select: { id: true } })
  return w?.id ?? null
}

/**
 * Public wrapper for `ensureVersionForDesign(...)` invoked manually from the
 * Publish endpoint.  Same dedupe semantics: identical content → reuse version.
 */
export async function ensureVersionForDesignManual(
  templateId: string,
  design: DesignWithGraph,
): Promise<{ version: number; created: boolean }> {
  return ensureVersionForDesign(templateId, design, 'manual')
}
