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
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { ValidationError } from '../../../lib/errors'
import { createWorkflowRunBudgetSnapshot } from '../runtime/budget'
import { tenantIdForCreate } from '../../../lib/tenant-isolation'
import { createWorkflowAuthorizationSnapshot, evaluateTemplatePermission } from '../../../lib/permissions/workflowTemplate'
import { collectRuntimeInputRequirements, missingRuntimeInputs } from './runtime-inputs'

export type CloneOpts = {
  templateId:      string
  name?:           string                    // optional run name
  vars?:           Record<string, unknown>   // override template variable defaults
  globals?:        Record<string, unknown>   // override INSTANCE-scoped team globals
  params?:         Record<string, unknown>   // launch-time workflow parameters
  budgetOverride?: unknown                    // optional run-level lowering of the template budget
  createdById?:    string
  initiativeId?:   string
}

export type CloneResult = {
  instance: { id: string; name: string; status: string; templateVersion: number | null; tenantId: string | null }
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

// Seed a PARALLEL_JOIN node's `expected_joins` from the graph topology (the
// number of incoming PARALLEL_JOIN edges = the branches that must arrive) when
// the designer set no explicit count. GraphTraverser's join counter defaults to
// 0 otherwise, so the guard `completed >= expected` never fires and the join —
// and the whole run — deadlocks. An explicit designer value always wins.
function seedJoinArity(
  nodeType: unknown,
  cfg: Prisma.InputJsonValue,
  incomingCount: number,
): Prisma.InputJsonValue {
  if (String(nodeType) !== 'PARALLEL_JOIN' || incomingCount <= 0) return cfg
  const obj = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? { ...(cfg as Record<string, unknown>) } : {}
  const std = (obj.standard && typeof obj.standard === 'object' && !Array.isArray(obj.standard))
    ? obj.standard as Record<string, unknown> : {}
  const hasExplicit = obj.expected_joins != null || obj.expectedBranches != null || std.expectedBranches != null
  if (hasExplicit) return cfg
  obj.expected_joins = incomingCount
  return obj as Prisma.InputJsonValue
}

// ── Snapshot building + content hashing ─────────────────────────────────────

type DesignWithGraph = {
  id: string
  phases: Array<{ id: string; name: string; displayOrder: number; color: string | null }>
  nodes:  Array<{ id: string; phaseId: string | null; nodeType: any; label: string;
                  nodeTypeKey?: string | null; nodeTypeVersion?: number | null; nodeTypeSnapshot?: unknown;
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
      nodeTypeKey: n.nodeTypeKey ?? n.nodeType,
      nodeTypeVersion: n.nodeTypeVersion ?? 1,
      nodeTypeSnapshot: n.nodeTypeSnapshot ?? null,
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
    select: { id: true, teamId: true, variables: true, name: true, capabilityId: true, budgetPolicy: true, profile: true },
  })
  if (!workflow) throw new Error(`Workflow ${templateId} not found`)

  const [designPhases, designNodes, designEdges] = await Promise.all([
    prisma.workflowDesignPhase.findMany({ where: { workflowId: templateId }, orderBy: { displayOrder: 'asc' } }),
    prisma.workflowDesignNode.findMany ({ where: { workflowId: templateId }, orderBy: { createdAt: 'asc' } }),
    prisma.workflowDesignEdge.findMany ({ where: { workflowId: templateId }, orderBy: { createdAt: 'asc' } }),
  ])
  if (designNodes.length === 0) {
    throw new ValidationError('Cannot start workflow run because the design has no nodes')
  }

  const design: DesignWithGraph = {
    id:     templateId,
    phases: designPhases.map(p => ({ id: p.id, name: p.name, displayOrder: p.displayOrder, color: p.color })),
    nodes:  designNodes.map(n => ({
      id: n.id, phaseId: n.phaseId, nodeType: n.nodeType, label: n.label,
      nodeTypeKey: n.nodeTypeKey, nodeTypeVersion: n.nodeTypeVersion, nodeTypeSnapshot: n.nodeTypeSnapshot,
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
  // Launch-time globals may be declared only by a node placeholder and not by
  // a team variable. Keep those values in the run context as well; the
  // runtime-input contract validates them before a run is created.
  for (const [key, value] of Object.entries(globalsOverrides)) {
    if (!(key in globals)) globals[key] = value
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

  const params = opts.params ?? {}

  const runtimeInputs = collectRuntimeInputRequirements(
    design.nodes.map(node => ({ id: node.id, label: node.label, nodeType: node.nodeType, config: node.config })),
    varDefs,
  )
  const missing = missingRuntimeInputs(runtimeInputs.inputs, { vars, globals, params })
  if (missing.length > 0) {
    const details = missing.map(input => `${input.reference} (${input.nodes.map(node => node.nodeLabel).join(', ') || 'workflow input'})`).join('; ')
    throw new ValidationError(`Workflow requires runtime inputs before start: ${details}. Provide them in the start request.`)
  }

  const initialContext: Record<string, unknown> = {}
  if (Object.keys(globals).length > 0) initialContext._globals = globals
  if (Object.keys(vars).length    > 0) initialContext._vars    = vars
  if (Object.keys(params).length  > 0) initialContext._params   = params

  // Runtime model override chosen at launch — a SYSTEM global (not a team var),
  // so it's threaded explicitly rather than via the team-variable merge above.
  // AgentTaskExecutor reads _globals.modelAlias as the highest-precedence model.
  const launchModelAlias = typeof globalsOverrides.modelAlias === 'string' ? globalsOverrides.modelAlias.trim() : ''
  if (launchModelAlias) {
    initialContext._globals = { ...((initialContext._globals as Record<string, unknown> | undefined) ?? {}), modelAlias: launchModelAlias }
  }

  // RLS prep — resolved once, used both for the pre-transaction count read below
  // and the run-creation transaction (Slice 3). Was previously computed inline
  // at instance-create time only; hoisted so the SAME value scopes every
  // RLS-scoped touch in this function.
  const tenantId = tenantIdForCreate(initialContext)

  // ── 3. Compute the next run number for naming ─────────────────────────────
  const runCount = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.count({
    where: { templateId },
  }), tenantId)
  const runName = opts.name ?? `${template.name} · Run #${runCount + 1}`

  // ── 3b. Snapshot the design graph and pin a version (deduped by content) ──
  // We do this *before* the transaction because creating a snapshot may itself
  // bump `template.currentVersion`; we want that committed regardless of run
  // outcome so identical clones in parallel still see the same version.
  const versionResult = await ensureVersionForDesign(templateId, design, 'auto')

  // ── 4. Clone everything in a single transaction ───────────────────────────
  const result = await withTenantDbTransaction<CloneResult>(prisma, async (tx) => {
    // 4a. Create the run instance row, pinned to the design version we just snapshotted
    const run = await tx.workflowInstance.create({
      data: {
        templateId,
        templateVersion: versionResult.version,
        name:        runName,
        status:      'DRAFT',
        tenantId,
        context:     initialContext as Prisma.InputJsonValue,
        createdById: opts.createdById,
        initiativeId: opts.initiativeId,
        // M85.s2 — instance inherits profile from the template so
        // blueprint-workbench can filter on the instance row directly
        // without joining the template every time.
        profile:     workflow.profile ?? 'main',
      },
    })

    await createWorkflowRunBudgetSnapshot(tx, {
      instanceId: run.id,
      templateId,
      templatePolicy: workflow.budgetPolicy,
      runOverride: opts.budgetOverride,
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

    // AND-join arity: count incoming PARALLEL_JOIN edges per target node so each
    // PARALLEL_JOIN node's `expected_joins` can be seeded from the topology (see
    // seedJoinArity). Keyed by design node id (design.edges use design ids).
    const joinIncoming = new Map<string, number>()
    for (const e of design.edges) {
      if (e.edgeType === 'PARALLEL_JOIN') {
        joinIncoming.set(e.targetNodeId, (joinIncoming.get(e.targetNodeId) ?? 0) + 1)
      }
    }

    // 4c. Nodes (id-mapped, status reset, config sanitized)
    const nodeIdMap = new Map<string, string>()
    for (const n of design.nodes) {
      const nn = await tx.workflowNode.create({
        data: {
          instanceId:         run.id,
          phaseId:            n.phaseId ? phaseIdMap.get(n.phaseId) ?? null : null,
          nodeType:           n.nodeType,
          nodeTypeKey:        n.nodeTypeKey ?? String(n.nodeType),
          nodeTypeVersion:    n.nodeTypeVersion ?? 1,
          nodeTypeSnapshot:   n.nodeTypeSnapshot as Prisma.InputJsonValue | undefined,
          label:              n.label,
          status:             'PENDING',
          config:             seedJoinArity(n.nodeType, sanitizeNodeConfig(n.config), joinIncoming.get(n.id) ?? 0),
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
        // Every design node was mapped above, so an unmapped endpoint means the
        // design graph is corrupt. Fail the run start loudly instead of silently
        // dropping the transition — a skipped edge would let a broken graph
        // appear to launch while missing a path the author intended.
        const missing = !newSource ? `source node ${e.sourceNodeId}` : `target node ${e.targetNodeId}`
        throw new ValidationError(`Cannot start workflow run: an edge references a ${missing} that is not part of this design. Fix the design graph before starting.`)
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
        tenantId:        run.tenantId ?? null,
      },
      cloned:           { phases: phaseIdMap.size, nodes: nodeIdMap.size, edges: edgeCount },
      pinnedToVersion:  versionResult.version,
      newVersionCreated: versionResult.created,
    }
  }, tenantId)

  // Capture the start-time authorization evidence after the graph clone has
  // committed. Sensitive runtime actions still perform live authorization;
  // this record makes the original access decision reproducible.
  if (opts.createdById) {
    const decision = await evaluateTemplatePermission(opts.createdById, templateId, 'start')
    if (decision.allowed) {
      await createWorkflowAuthorizationSnapshot({
        instanceId: result.instance.id,
        workflowId: templateId,
        tenantId: result.instance.tenantId,
        actorWorkGraphId: opts.createdById,
        actorIamUserId: decision.actorIamUserId,
        capabilityId: decision.capabilityId,
        runOwnerId: opts.createdById,
        decision,
      })
    }
  }
  return result
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
