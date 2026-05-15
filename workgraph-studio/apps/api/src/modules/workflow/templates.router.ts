import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, publishOutbox } from '../../lib/audit'
import { assertTemplatePermission, resolveDefaultTeamId } from '../../lib/permissions/workflowTemplate'
import { cloneDesignToRun, getDesignInstanceId } from './lib/cloneDesignToRun'
import { startInstance } from './runtime/WorkflowRuntime'
import { validateNodeConfig } from '../lookup/resolver'
import { listAgentTemplates, type AgentTemplate } from '../../lib/agent-and-tools/client'
import { normalizeBudgetPolicy } from './runtime/budget'
import { resolveTeamIdForWorkflow, tokenFromAuthorizationHeader } from '../../lib/iam/teamMirror'

export const workflowTemplatesRouter: Router = Router()

const metadataSchema = z.object({
  teamName:             z.string().optional(),
  globallyAvailable:    z.boolean().optional(),
  workflowType:         z.enum(['SDLC','BUSINESS','DATA_PIPELINE','INFRASTRUCTURE','COMPLIANCE','OTHER']).optional(),
  domain:               z.string().optional(),
  criticality:          z.enum(['CRITICAL','HIGH','MEDIUM','LOW']).optional(),
  executionTarget:      z.enum(['SERVER','CLIENT','ALL']).optional(),
  visibility:           z.enum(['GLOBAL','TEAM','PRIVATE']).optional(),
  dataSensitivity:      z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']).optional(),
  requiresApprovalToRun: z.boolean().optional(),
  slaHours:             z.number().optional(),
  owner:                z.string().optional(),
  tags:                 z.array(z.object({ key: z.string(), value: z.string() })).optional(),
}).optional()

const variableDefSchema = z.object({
  key:          z.string().min(1).max(80).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Key must be a valid identifier'),
  label:        z.string().optional(),
  type:         z.enum(['STRING', 'NUMBER', 'BOOLEAN', 'JSON']).default('STRING'),
  defaultValue: z.unknown().optional(),
  description:  z.string().optional(),
  scope:        z.enum(['INPUT', 'CONSTANT']).default('INPUT'),
})

const createTemplateSchema = z.object({
  name:         z.string().min(1),
  description:  z.string().optional(),
  teamId:       z.string().optional(),
  // ID of the owning capability in Singularity IAM.  When set, this is the
  // authorization boundary for view/edit/start checks.
  capabilityId: z.string().optional(),
  metadata:     metadataSchema,
  variables:    z.array(variableDefSchema).optional(),
  budgetPolicy: z.record(z.unknown()).optional(),
  starter:      z.enum(['EMPTY', 'CAPABILITY_WORKBENCH_BRIDGE']).optional(),
})

const updateTemplateSchema = z.object({
  name:         z.string().min(1).optional(),
  description:  z.string().optional(),
  teamId:       z.string().optional(),
  capabilityId: z.string().nullable().optional(),
  metadata:     metadataSchema,
  variables:    z.array(variableDefSchema).optional(),
  budgetPolicy: z.record(z.unknown()).nullable().optional(),
})

workflowTemplatesRouter.post('/', validate(createTemplateSchema), async (req, res, next) => {
  try {
    const { name, description, teamId, capabilityId, metadata, variables, budgetPolicy, starter } =
      req.body as z.infer<typeof createTemplateSchema>
    if (starter === 'CAPABILITY_WORKBENCH_BRIDGE' && !capabilityId) {
      throw new ValidationError('Capability is required for the Workbench agent-team approval starter')
    }
    const callerToken = tokenFromAuthorizationHeader(req.headers.authorization)
    const ownerTeamId = teamId
      ? await resolveTeamIdForWorkflow(teamId, callerToken)
      : await resolveDefaultTeamId(req.user!.userId)

    const normalizedVariables = starter === 'CAPABILITY_WORKBENCH_BRIDGE'
      ? withCapabilityWorkbenchInputs(variables)
      : (variables ?? [])

    const template = await prisma.workflow.create({
      data: {
        name, description,
        teamId:       ownerTeamId,
        capabilityId: capabilityId ?? null,
        createdById:  req.user!.userId,
        metadata:     metadata as any ?? {},
        variables:    normalizedVariables as unknown as Prisma.InputJsonValue,
        budgetPolicy: normalizeBudgetPolicy(budgetPolicy) as unknown as Prisma.InputJsonValue,
      },
    })

    if (starter === 'CAPABILITY_WORKBENCH_BRIDGE') {
      await createCapabilityWorkbenchBridgeGraph({
        workflowId: template.id,
        capabilityId: capabilityId ?? '',
        actorId: req.user!.userId,
        authHeader: req.headers.authorization,
        goal: description?.trim() || name,
      })
    }

    // The design graph (phases/nodes/edges) is owned directly by the
    // Workflow row in workflow_design_* tables. Starter templates may create
    // an initial graph; otherwise clients use the design CRUD endpoints.
    await logEvent('WorkflowCreated', 'Workflow', template.id, req.user!.userId, {
      name: template.name, teamId: ownerTeamId, capabilityId, starter: starter ?? 'EMPTY',
    })
    res.status(201).json({ ...template, designInstanceId: template.id })
  } catch (err) {
    next(err)
  }
})

type StarterAgentBindings = {
  productOwnerAgentTemplateId: string
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  securityAgentTemplateId: string
  qaAgentTemplateId: string
  devopsAgentTemplateId: string
}

async function createCapabilityWorkbenchBridgeGraph({
  workflowId,
  capabilityId,
  actorId,
  authHeader,
  goal,
}: {
  workflowId: string
  capabilityId: string
  actorId: string
  authHeader?: string
  goal: string
}) {
  const { bindings, warnings } = await resolveStarterAgentBindings(capabilityId, authHeader)
  const workbenchGoal = goal || 'Produce an approved implementation contract pack.'
  const workbenchConfig = buildWorkbenchConfig(capabilityId, bindings, workbenchGoal)

  const [startNode, workbenchNode, approvalNode, endNode] = await prisma.$transaction(async tx => {
    const start = await tx.workflowDesignNode.create({
      data: {
        workflowId,
        nodeType: 'START' as any,
        label: 'Start',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: 80,
        positionY: 220,
      },
    })
    const workbench = await tx.workflowDesignNode.create({
      data: {
        workflowId,
        nodeType: 'WORKBENCH_TASK' as any,
        label: 'Blueprint Workbench',
        config: {
          assignmentMode: 'DIRECT_USER',
          assignedToId: actorId,
          workbench: workbenchConfig,
          outputArtifacts: workbenchOutputBindings(),
          starterWarnings: warnings,
        } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 330,
        positionY: 220,
      },
    })
    const approval = await tx.workflowDesignNode.create({
      data: {
        workflowId,
        nodeType: 'APPROVAL' as any,
        label: 'Human final sign-off',
        config: {
          assignmentMode: 'DIRECT_USER',
          assignedToId: actorId,
          subject: 'Blueprint final implementation pack',
          formWidgets: [
            {
              id: 'approvalNotes',
              type: 'textarea',
              label: 'Approval notes',
              required: false,
              placeholder: 'Capture any rollout conditions, risk acceptance, or follow-up work.',
            },
          ],
        } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 610,
        positionY: 220,
      },
    })
    const end = await tx.workflowDesignNode.create({
      data: {
        workflowId,
        nodeType: 'END' as any,
        label: 'Done',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: 870,
        positionY: 220,
      },
    })
    await tx.workflowDesignEdge.createMany({
      data: [
        { workflowId, sourceNodeId: start.id, targetNodeId: workbench.id, edgeType: 'SEQUENTIAL' as any },
        { workflowId, sourceNodeId: workbench.id, targetNodeId: approval.id, edgeType: 'SEQUENTIAL' as any },
        { workflowId, sourceNodeId: approval.id, targetNodeId: end.id, edgeType: 'SEQUENTIAL' as any },
      ],
    })
    return [start, workbench, approval, end] as const
  })

  await logEvent('WorkflowStarterApplied', 'Workflow', workflowId, actorId, {
    starter: 'CAPABILITY_WORKBENCH_BRIDGE',
    capabilityId,
    nodeIds: {
      start: startNode.id,
      workbench: workbenchNode.id,
      approval: approvalNode.id,
      end: endNode.id,
    },
    warnings,
  })
}

async function resolveStarterAgentBindings(
  capabilityId: string,
  authHeader?: string,
): Promise<{ bindings: StarterAgentBindings; warnings: string[] }> {
  const warnings: string[] = []
  if (!capabilityId) {
    warnings.push('No capability selected; choose a capability before running this workflow.')
    return { bindings: emptyBindings(), warnings }
  }

  let templates: AgentTemplate[] = []
  try {
    templates = await listAgentTemplates(authHeader, { scope: 'all', capabilityId, limit: 100 })
  } catch (err) {
    warnings.push(`Could not prefetch capability agent templates: ${(err as Error).message}`)
  }

  const pick = (role: 'ARCHITECT' | 'DEVELOPER' | 'QA' | 'SECURITY' | 'DEVOPS' | 'PRODUCT_OWNER') => {
    const normalized = templates
      .map(t => ({ template: t, role: roleOfTemplate(t), name: String(t.name ?? '').toLowerCase() }))
      .filter(x => isUsableTemplate(x.template))
    return (
      normalized.find(x => x.template.capabilityId === capabilityId && x.role === role)?.template.id ??
      normalized.find(x => x.role === role)?.template.id ??
      normalized.find(x => x.template.capabilityId === capabilityId && x.name.includes(role.toLowerCase()))?.template.id ??
      normalized.find(x => x.name.includes(role.toLowerCase()))?.template.id ??
      ''
    )
  }

  const bindings = {
    productOwnerAgentTemplateId: pick('PRODUCT_OWNER'),
    architectAgentTemplateId: pick('ARCHITECT'),
    developerAgentTemplateId: pick('DEVELOPER'),
    securityAgentTemplateId: pick('SECURITY'),
    qaAgentTemplateId: pick('QA'),
    devopsAgentTemplateId: pick('DEVOPS'),
  }

  if (!bindings.productOwnerAgentTemplateId) warnings.push('Product Owner agent template was not found; the Workbench will start at architecture planning.')
  if (!bindings.architectAgentTemplateId) warnings.push('Architect agent template was not found; bind one in the Workbench node inspector.')
  if (!bindings.developerAgentTemplateId) warnings.push('Developer agent template was not found; bind one in the Workbench node inspector.')
  if (!bindings.securityAgentTemplateId) warnings.push('Security agent template was not found; security review will fall back to QA if needed.')
  if (!bindings.qaAgentTemplateId) warnings.push('QA agent template was not found; bind one in the Workbench node inspector.')
  if (!bindings.devopsAgentTemplateId) warnings.push('DevOps agent template was not found; release readiness will fall back to QA if needed.')

  return { bindings, warnings }
}

function emptyBindings(): StarterAgentBindings {
  return {
    productOwnerAgentTemplateId: '',
    architectAgentTemplateId: '',
    developerAgentTemplateId: '',
    securityAgentTemplateId: '',
    qaAgentTemplateId: '',
    devopsAgentTemplateId: '',
  }
}

function isUsableTemplate(t: AgentTemplate): boolean {
  const status = String(t.status ?? (t.isActive === false ? 'INACTIVE' : 'ACTIVE')).toUpperCase()
  return status !== 'ARCHIVED' && status !== 'INACTIVE' && status !== 'DELETED'
}

function roleOfTemplate(t: AgentTemplate): string {
  const raw = t.roleType ?? t.role ?? t.agentRole ?? t.category ?? ''
  return String(raw).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function buildWorkbenchConfig(
  capabilityId: string,
  bindings: StarterAgentBindings,
  goal: string,
) {
  return {
    profile: 'blueprint',
    gateMode: 'manual',
    sourceType: 'github',
    sourceUri: '{{instance.vars.repoUrl}}',
    sourceRef: '',
    goal: '{{instance.vars.story}}',
    fallbackGoal: goal,
    capabilityId,
    agentBindings: bindings,
    loopDefinition: {
      version: 1,
      name: 'Capability implementation workbench loop',
      maxLoopsPerStage: 3,
      maxTotalSendBacks: 8,
      stages: [
        {
          key: 'STORY_INTAKE',
          label: 'Story Intake',
          agentRole: 'PRODUCT_OWNER',
          agentTemplateId: bindings.productOwnerAgentTemplateId || bindings.architectAgentTemplateId,
          next: 'PLAN',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: [],
          expectedArtifacts: [
            { kind: 'story_brief', title: 'Story brief', required: true, format: 'MARKDOWN' },
            { kind: 'acceptance_contract', title: 'Acceptance contract', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'PLAN',
          label: 'Plan',
          agentRole: 'ARCHITECT',
          agentTemplateId: bindings.architectAgentTemplateId,
          next: 'DESIGN',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['STORY_INTAKE'],
          expectedArtifacts: [
            { kind: 'mental_model', title: 'Mental model', required: true, format: 'MARKDOWN' },
            { kind: 'gaps', title: 'Gaps and risks', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'DESIGN',
          label: 'Design',
          agentRole: 'ARCHITECT',
          agentTemplateId: bindings.architectAgentTemplateId,
          next: 'DEVELOP',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['STORY_INTAKE', 'PLAN'],
          expectedArtifacts: [
            { kind: 'solution_architecture', title: 'Solution architecture', required: true, format: 'MARKDOWN' },
            { kind: 'approved_spec_draft', title: 'Approved spec draft', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'DEVELOP',
          label: 'Develop',
          agentRole: 'DEVELOPER',
          agentTemplateId: bindings.developerAgentTemplateId,
          next: 'SECURITY_REVIEW',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['STORY_INTAKE', 'PLAN', 'DESIGN'],
          expectedArtifacts: [
            { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
            { kind: 'simulated_code_change', title: 'Simulated code-change evidence', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'SECURITY_REVIEW',
          label: 'Security Review',
          agentRole: 'SECURITY',
          agentTemplateId: bindings.securityAgentTemplateId || bindings.qaAgentTemplateId,
          next: 'QA_REVIEW',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['PLAN', 'DESIGN', 'DEVELOP'],
          expectedArtifacts: [
            { kind: 'security_review', title: 'Security review', required: true, format: 'MARKDOWN' },
            { kind: 'risk_acceptance_notes', title: 'Risk acceptance notes', required: false, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'QA_REVIEW',
          label: 'QA Review',
          agentRole: 'QA',
          agentTemplateId: bindings.qaAgentTemplateId,
          next: 'RELEASE_READINESS',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP', 'SECURITY_REVIEW'],
          expectedArtifacts: [
            { kind: 'qa_task_pack', title: 'QA review pack', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'RELEASE_READINESS',
          label: 'Release Readiness',
          agentRole: 'DEVOPS',
          agentTemplateId: bindings.devopsAgentTemplateId || bindings.qaAgentTemplateId,
          next: 'TEST_CERTIFICATION',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DEVELOP', 'SECURITY_REVIEW', 'QA_REVIEW'],
          expectedArtifacts: [
            { kind: 'release_plan', title: 'Release plan', required: true, format: 'MARKDOWN' },
            { kind: 'rollback_plan', title: 'Rollback plan', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'TEST_CERTIFICATION',
          label: 'Test Certification',
          agentRole: 'QA',
          agentTemplateId: bindings.qaAgentTemplateId,
          terminal: true,
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP', 'SECURITY_REVIEW', 'QA_REVIEW', 'RELEASE_READINESS'],
          expectedArtifacts: [
            { kind: 'verification_rules', title: 'Verification rules', required: true, format: 'MARKDOWN' },
            { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
            { kind: 'certification_receipt', title: 'Certification receipt', required: true, format: 'MARKDOWN' },
          ],
        },
      ],
    },
    outputs: {
      finalPackKey: 'finalImplementationPack',
    },
  }
}

function workbenchOutputBindings() {
  return [
    { id: 'workbench-final-pack', name: 'finalImplementationPack', bindingPath: 'workbench.finalPack', required: true },
    { id: 'workbench-final-pack-consumable', name: 'finalPackConsumableId', bindingPath: 'workbench.finalPackConsumableId', required: false },
    { id: 'workbench-consumable-ids', name: 'consumableIds', bindingPath: 'workbench.consumableIds', required: false },
    { id: 'workbench-stage-artifacts-by-kind', name: 'stageArtifactsByKind', bindingPath: 'workbench.stageArtifactsByKind', required: false },
  ]
}

function withCapabilityWorkbenchInputs(
  variables: z.infer<typeof variableDefSchema>[] | undefined,
): z.infer<typeof variableDefSchema>[] {
  const existing = variables ?? []
  const seen = new Set(existing.map(v => v.key))
  const defaults: z.infer<typeof variableDefSchema>[] = [
    {
      key: 'story',
      label: 'Input story',
      type: 'STRING',
      scope: 'INPUT',
      description: 'The user story or change request the agent team should refine and deliver.',
    },
    {
      key: 'acceptanceCriteria',
      label: 'Acceptance criteria',
      type: 'STRING',
      scope: 'INPUT',
      description: 'Optional acceptance criteria, constraints, or definition of done.',
    },
    {
      key: 'repoUrl',
      label: 'Repository URL',
      type: 'STRING',
      scope: 'INPUT',
      description: 'GitHub repository or source location for the Workbench to inspect.',
    },
  ]
  return [
    ...existing,
    ...defaults.filter(v => !seen.has(v.key)),
  ]
}

// ─── Runs (instances cloned from the design) ─────────────────────────────────

const startRunSchema = z.object({
  name:    z.string().optional(),
  vars:    z.record(z.unknown()).optional(),
  globals: z.record(z.unknown()).optional(),
  budgetOverride: z.record(z.unknown()).optional(),
  initiativeId: z.string().uuid().optional(),
})

// POST /workflow-templates/:id/runs — start a new run by cloning the design.
workflowTemplatesRouter.post('/:id/runs', validate(startRunSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'start')
    const body = req.body as z.infer<typeof startRunSchema>

    const result = await cloneDesignToRun({
      templateId:   id,
      name:         body.name,
      vars:         body.vars,
      globals:      body.globals,
      budgetOverride: body.budgetOverride,
      createdById:  req.user!.userId,
      initiativeId: body.initiativeId,
    })

    await logEvent('WorkflowRunCreated', 'WorkflowInstance', result.instance.id, req.user!.userId, {
      templateId: id, cloned: result.cloned,
    })
    await publishOutbox('WorkflowInstance', result.instance.id, 'WorkflowRunCreated', {
      instanceId: result.instance.id, templateId: id,
    })
    await startInstance(result.instance.id, req.user!.userId)
    const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: result.instance.id } })
    res.status(201).json(instance)
  } catch (err) { next(err) }
})

// GET /workflow-templates/:id/runs — list executions for a template.
workflowTemplatesRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const runs = await prisma.workflowInstance.findMany({
      where:   { templateId: id },
      orderBy: { createdAt: 'desc' },
      select:  {
        id: true, name: true, status: true,
        templateVersion: true,
        createdAt: true, startedAt: true, completedAt: true,
      },
    })
    res.json(runs)
  } catch (err) { next(err) }
})

// GET /workflow-templates/:id/versions — version history (used by run-detail and audit).
workflowTemplatesRouter.get('/:id/versions', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const versions = await prisma.workflowVersion.findMany({
      where:   { templateId: id },
      orderBy: { version: 'desc' },
      select:  {
        id: true, version: true, contentHash: true, source: true, createdAt: true,
      },
    })
    res.json(versions)
  } catch (err) { next(err) }
})

// POST /workflow-templates/:id/publish-version — manual snapshot of the current
// design graph (no run started).  Returns the version number; reuses an existing
// version when the design hasn't drifted from the last snapshot.
workflowTemplatesRouter.post('/:id/publish-version', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')

    const [phases, nodes, edges] = await Promise.all([
      prisma.workflowDesignPhase.findMany({ where: { workflowId: id }, orderBy: { displayOrder: 'asc' } }),
      prisma.workflowDesignNode.findMany ({ where: { workflowId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.workflowDesignEdge.findMany ({ where: { workflowId: id }, orderBy: { createdAt: 'asc' } }),
    ])

    const designForSnapshot = {
      id,
      phases: phases.map(p => ({ id: p.id, name: p.name, displayOrder: p.displayOrder, color: p.color })),
      nodes:  nodes.map(n => ({
        id: n.id, phaseId: n.phaseId, nodeType: n.nodeType, label: n.label,
        config: n.config, compensationConfig: n.compensationConfig,
        executionLocation: n.executionLocation, positionX: n.positionX, positionY: n.positionY,
      })),
      edges:  edges.map(e => ({
        id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
        edgeType: e.edgeType, condition: e.condition, label: e.label,
      })),
    }

    const { ensureVersionForDesignManual } = await import('./lib/cloneDesignToRun')
    const result = await ensureVersionForDesignManual(id, designForSnapshot)

    await logEvent('WorkflowVersionPublished', 'Workflow', id, req.user!.userId, {
      version: result.version, created: result.created,
    })
    res.status(result.created ? 201 : 200).json(result)
  } catch (err) { next(err) }
})

// GET /workflow-templates/:id/design — the design instance id (back-compat).
// Returns the workflow id itself; the studio uses this to navigate.
workflowTemplatesRouter.get('/:id/design', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const designId = await getDesignInstanceId(id)
    res.json({ designInstanceId: designId })
  } catch (err) { next(err) }
})

// ─── Design graph endpoints ──────────────────────────────────────────────────
// CRUD for the workflow's design — phases, nodes, edges.  These are the
// editable surface; runs clone snapshots of this graph.

const designNodeBodySchema = z.object({
  phaseId:           z.string().uuid().nullable().optional(),
  nodeType:          z.string(),
  label:             z.string().min(1),
  config:            z.record(z.unknown()).optional(),
  compensationConfig: z.record(z.unknown()).nullable().optional(),
  executionLocation: z.enum(['SERVER','CLIENT','EDGE','EXTERNAL']).optional(),
  positionX:         z.number().optional(),
  positionY:         z.number().optional(),
})

const designEdgeBodySchema = z.object({
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  edgeType:     z.enum(['SEQUENTIAL','CONDITIONAL','PARALLEL_SPLIT','PARALLEL_JOIN','ERROR_BOUNDARY']).default('SEQUENTIAL'),
  condition:    z.record(z.unknown()).nullable().optional(),
  label:        z.string().nullable().optional(),
})

const designPhaseBodySchema = z.object({
  name:         z.string().min(1),
  displayOrder: z.number().int().default(0),
  color:        z.string().nullable().optional(),
})

// Read the full design graph in one round-trip — used by the studio on open.
workflowTemplatesRouter.get('/:id/design-graph', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const [phases, nodes, edges] = await Promise.all([
      prisma.workflowDesignPhase.findMany({ where: { workflowId: id }, orderBy: { displayOrder: 'asc' } }),
      prisma.workflowDesignNode.findMany ({ where: { workflowId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.workflowDesignEdge.findMany ({ where: { workflowId: id }, orderBy: { createdAt: 'asc' } }),
    ])
    res.json({ phases, nodes, edges })
  } catch (err) { next(err) }
})

// Phases
workflowTemplatesRouter.post('/:id/design/phases', validate(designPhaseBodySchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof designPhaseBodySchema>
    const created = await prisma.workflowDesignPhase.create({ data: { workflowId: id, ...body } })
    res.status(201).json(created)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.patch('/:id/design/phases/:phaseId', validate(designPhaseBodySchema.partial()), async (req, res, next) => {
  try {
    const id      = req.params.id as string
    const phaseId = req.params.phaseId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const updated = await prisma.workflowDesignPhase.update({ where: { id: phaseId }, data: req.body })
    res.json(updated)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.delete('/:id/design/phases/:phaseId', async (req, res, next) => {
  try {
    const id      = req.params.id as string
    const phaseId = req.params.phaseId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    await prisma.workflowDesignPhase.delete({ where: { id: phaseId } })
    res.status(204).end()
  } catch (err) { next(err) }
})

// Nodes
workflowTemplatesRouter.post('/:id/design/nodes', validate(designNodeBodySchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof designNodeBodySchema>

    // M11.b — write-time cross-service ref validation. Skipped when the
    // header `x-skip-ref-validation: 1` is set (used by tests + bulk imports).
    if (req.headers['x-skip-ref-validation'] !== '1') {
      const v = await validateNodeConfig(body.nodeType, body.config ?? {}, req)
      if (!v.ok) {
        return res.status(422).json({
          code: 'REF_VALIDATION_FAILED',
          message: 'one or more cross-service references could not be resolved',
          failures: v.failures,
        })
      }
    }

    const created = await prisma.workflowDesignNode.create({
      data: {
        workflowId:        id,
        phaseId:           body.phaseId ?? null,
        nodeType:          body.nodeType as any,
        label:             body.label,
        config:            (body.config ?? {}) as Prisma.InputJsonValue,
        compensationConfig: body.compensationConfig as Prisma.InputJsonValue | undefined,
        executionLocation: (body.executionLocation ?? 'SERVER') as any,
        positionX:         body.positionX ?? 0,
        positionY:         body.positionY ?? 0,
      },
    })
    res.status(201).json(created)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.patch('/:id/design/nodes/:nodeId', validate(designNodeBodySchema.partial()), async (req, res, next) => {
  try {
    const id     = req.params.id as string
    const nodeId = req.params.nodeId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as Partial<z.infer<typeof designNodeBodySchema>>

    // M11.b — re-validate when config or nodeType changes.
    if (req.headers['x-skip-ref-validation'] !== '1' && (body.config !== undefined || body.nodeType !== undefined)) {
      const existing = await prisma.workflowDesignNode.findUnique({ where: { id: nodeId } })
      if (!existing) throw new NotFoundError('WorkflowDesignNode', nodeId)
      const effectiveType   = body.nodeType ?? existing.nodeType
      const effectiveConfig = (body.config !== undefined ? body.config : existing.config) as Record<string, unknown> | null
      const v = await validateNodeConfig(effectiveType, effectiveConfig ?? {}, req)
      if (!v.ok) {
        return res.status(422).json({
          code: 'REF_VALIDATION_FAILED',
          message: 'one or more cross-service references could not be resolved',
          failures: v.failures,
        })
      }
    }

    const updated = await prisma.workflowDesignNode.update({
      where: { id: nodeId },
      data: ({
        ...(body.phaseId           !== undefined ? { phaseId:           body.phaseId           } : {}),
        ...(body.nodeType          !== undefined ? { nodeType:          body.nodeType          } : {}),
        ...(body.label             !== undefined ? { label:             body.label             } : {}),
        ...(body.config            !== undefined ? { config:            body.config            } : {}),
        ...(body.compensationConfig !== undefined ? { compensationConfig: body.compensationConfig ?? Prisma.JsonNull } : {}),
        ...(body.executionLocation !== undefined ? { executionLocation: body.executionLocation } : {}),
        ...(body.positionX         !== undefined ? { positionX:         body.positionX         } : {}),
        ...(body.positionY         !== undefined ? { positionY:         body.positionY         } : {}),
      } as any),
    })
    res.json(updated)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.delete('/:id/design/nodes/:nodeId', async (req, res, next) => {
  try {
    const id     = req.params.id as string
    const nodeId = req.params.nodeId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    await prisma.workflowDesignNode.delete({ where: { id: nodeId } })
    res.status(204).end()
  } catch (err) { next(err) }
})

// Edges
workflowTemplatesRouter.post('/:id/design/edges', validate(designEdgeBodySchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof designEdgeBodySchema>
    const created = await prisma.workflowDesignEdge.create({
      data: {
        workflowId:   id,
        sourceNodeId: body.sourceNodeId,
        targetNodeId: body.targetNodeId,
        edgeType:     body.edgeType as any,
        condition:    body.condition as Prisma.InputJsonValue | undefined,
        label:        body.label,
      },
    })
    res.status(201).json(created)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.patch('/:id/design/edges/:edgeId', validate(designEdgeBodySchema.partial()), async (req, res, next) => {
  try {
    const id     = req.params.id as string
    const edgeId = req.params.edgeId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as Partial<z.infer<typeof designEdgeBodySchema>>
    const updated = await prisma.workflowDesignEdge.update({
      where: { id: edgeId },
      data: ({
        ...(body.edgeType  !== undefined ? { edgeType:  body.edgeType  } : {}),
        ...(body.condition !== undefined ? { condition: body.condition ?? Prisma.JsonNull } : {}),
        ...(body.label     !== undefined ? { label:     body.label     } : {}),
      } as any),
    })
    res.json(updated)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.delete('/:id/design/edges/:edgeId', async (req, res, next) => {
  try {
    const id     = req.params.id as string
    const edgeId = req.params.edgeId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    await prisma.workflowDesignEdge.delete({ where: { id: edgeId } })
    res.status(204).end()
  } catch (err) { next(err) }
})

workflowTemplatesRouter.patch('/:id', validate(updateTemplateSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof updateTemplateSchema>

    const resolvedTeamId = body.teamId !== undefined
      ? await resolveTeamIdForWorkflow(body.teamId, tokenFromAuthorizationHeader(req.headers.authorization))
      : undefined

    const t = await prisma.workflow.update({
      where: { id },
      data: {
        ...(body.name         !== undefined ? { name:         body.name }                                              : {}),
        ...(body.description  !== undefined ? { description:  body.description }                                       : {}),
        ...(resolvedTeamId    !== undefined ? { teamId:       resolvedTeamId }                                        : {}),
        ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId }                                      : {}),
        ...(body.metadata     !== undefined ? { metadata:     body.metadata as any }                                   : {}),
        ...(body.variables    !== undefined ? { variables:    body.variables as unknown as Prisma.InputJsonValue }     : {}),
        ...(body.budgetPolicy !== undefined ? { budgetPolicy: normalizeBudgetPolicy(body.budgetPolicy) as unknown as Prisma.InputJsonValue } : {}),
      },
    })
    await logEvent('TemplateUpdated', 'WorkflowTemplate', t.id, req.user!.userId, {
      keys: Object.keys(body),
    })
    res.json(t)
  } catch (err) { next(err) }
})

workflowTemplatesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const showArchived = req.query.archived === 'true'
    const capabilityId = typeof req.query.capabilityId === 'string' && req.query.capabilityId.trim()
      ? req.query.capabilityId.trim()
      : undefined
    const where: Prisma.WorkflowWhereInput = {
      archivedAt: showArchived ? { not: null } : null,
      ...(capabilityId ? { capabilityId } : {}),
    }
    const [templates, total] = await Promise.all([
      prisma.workflow.findMany({ where, skip: pg.skip, take: pg.take, orderBy: { name: 'asc' } }),
      prisma.workflow.count({ where }),
    ])
    res.json(toPageResponse(templates, total, pg))
  } catch (err) {
    next(err)
  }
})

workflowTemplatesRouter.get('/:id', async (req, res, next) => {
  try {
    const template = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
    if (!template) throw new NotFoundError('WorkflowTemplate', req.params.id)
    res.json(template)
  } catch (err) {
    next(err)
  }
})

// ─── Export ────────────────────────────────────────────────────────────────────

workflowTemplatesRouter.get('/:id/export', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const template = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
    if (!template) throw new NotFoundError('WorkflowTemplate', id)

    const exportDoc = {
      _exportVersion: 2,
      exportedAt: new Date().toISOString(),
      template: {
        name: template.name,
        description: template.description,
        currentVersion: template.currentVersion,
        status: template.status,
        metadata: template.metadata ?? null,
      },
      latestGraphSnapshot: template.versions[0]?.graphSnapshot ?? null,
    }

    res.setHeader('Content-Disposition', `attachment; filename="workflow-${template.id}.json"`)
    res.setHeader('Content-Type', 'application/json')
    res.json(exportDoc)
  } catch (err) {
    next(err)
  }
})

// ─── Import ────────────────────────────────────────────────────────────────────

const importTemplateSchema = z.object({
  _exportVersion: z.number().int().optional(),
  template: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  }),
  latestGraphSnapshot: z.record(z.unknown()).nullable().optional(),
})

workflowTemplatesRouter.post('/import', validate(importTemplateSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof importTemplateSchema>
    const teamId = await resolveDefaultTeamId(req.user!.userId)

    const template = await prisma.workflow.create({
      data: {
        name: body.template.name,
        description: body.template.description,
        metadata: body.template.metadata as Prisma.InputJsonValue ?? Prisma.JsonNull,
        createdById: req.user!.userId,
        teamId,
        currentVersion: 1,
      },
    })

    if (body.latestGraphSnapshot) {
      await prisma.workflowVersion.create({
        data: {
          templateId: template.id,
          version: 1,
          graphSnapshot: body.latestGraphSnapshot as unknown as Prisma.InputJsonValue,
        },
      })
    }

    const full = await prisma.workflow.findUnique({
      where: { id: template.id },
      include: { versions: true },
    })
    res.status(201).json(full)
  } catch (err) {
    next(err)
  }
})

// ─── Status transitions ───────────────────────────────────────────────────────

workflowTemplatesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    const t = await prisma.workflow.update({ where: { id: req.params.id }, data: { status: 'PUBLISHED' } })
    await logEvent('TemplatePublished', 'WorkflowTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

workflowTemplatesRouter.post('/:id/mark-final', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    const t = await prisma.workflow.update({ where: { id: req.params.id }, data: { status: 'FINAL' } })
    await logEvent('TemplateMarkedFinal', 'WorkflowTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

// ─── Duplicate ────────────────────────────────────────────────────────────────

workflowTemplatesRouter.post('/:id/duplicate', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'view')
    const source = await prisma.workflow.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })

    const { name, asNewVersion } = req.body as { name: string; asNewVersion?: boolean }
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' })

    const teamId = await resolveDefaultTeamId(req.user!.userId)
    const copy = await prisma.workflow.create({
      data: {
        name: name.trim(),
        description: source.description,
        teamId,
        createdById: req.user!.userId,
        status: 'DRAFT',
        metadata: (source.metadata ?? {}) as any,
        currentVersion: asNewVersion ? (source.currentVersion + 1) : 1,
      },
    })

    if (source.versions[0]) {
      await prisma.workflowVersion.create({
        data: {
          templateId: copy.id,
          version: 1,
          graphSnapshot: source.versions[0].graphSnapshot as any,
        },
      })
    }

    await logEvent('TemplateDuplicated', 'WorkflowTemplate', copy.id, req.user!.userId, {
      sourceId: source.id, asNewVersion: !!asNewVersion,
    })
    res.status(201).json(copy)
  } catch (err) { next(err) }
})

// ─── Archive / Restore ────────────────────────────────────────────────────────

workflowTemplatesRouter.post('/:id/archive', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    const t = await prisma.workflow.update({
      where: { id: req.params.id },
      data: { archivedAt: new Date() },
    })
    await logEvent('TemplateArchived', 'WorkflowTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

workflowTemplatesRouter.post('/:id/restore', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    const t = await prisma.workflow.update({
      where: { id: req.params.id },
      data: { archivedAt: null },
    })
    await logEvent('TemplateRestored', 'WorkflowTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

workflowTemplatesRouter.delete('/:id', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    await prisma.workflow.delete({ where: { id: req.params.id } })
    await logEvent('TemplateDeleted', 'WorkflowTemplate', req.params.id, req.user!.userId)
    res.status(204).end()
  } catch (err) { next(err) }
})

// ─── Save new version ─────────────────────────────────────────────────────────

workflowTemplatesRouter.post('/:id/versions', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'edit')
    const template = await prisma.workflow.findUniqueOrThrow({ where: { id: req.params.id } })
    const nextVersion = template.currentVersion + 1
    const version = await prisma.workflowVersion.create({
      data: {
        templateId: template.id,
        version: nextVersion,
        graphSnapshot: (req.body.graphSnapshot ?? {}) as any,
      },
    })
    await prisma.workflow.update({ where: { id: template.id }, data: { currentVersion: nextVersion } })
    await logEvent('TemplateVersionCreated', 'WorkflowTemplate', template.id, req.user!.userId, { version: nextVersion })
    res.status(201).json(version)
  } catch (err) { next(err) }
})

// ─── BPMN 2.0 Export ─────────────────────────────────────────────────────────

workflowTemplatesRouter.get('/:id/export-bpmn', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const template = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
    if (!template) throw new NotFoundError('WorkflowTemplate', id)

    const snapshot = (template.versions[0]?.graphSnapshot ?? { nodes: [], edges: [] }) as any
    const bpmnXml = templateToBpmn(template.name, id, snapshot)

    res.setHeader('Content-Disposition', `attachment; filename="workflow-${id}.bpmn"`)
    res.setHeader('Content-Type', 'application/xml')
    res.send(bpmnXml)
  } catch (err) { next(err) }
})

// ─── BPMN 2.0 Import ─────────────────────────────────────────────────────────

workflowTemplatesRouter.post('/import-bpmn', async (req, res, next) => {
  try {
    const { xml, name } = req.body as { xml: string; name?: string }
    if (!xml) return res.status(400).json({ error: 'xml is required' })
    const snapshot = bpmnToSnapshot(xml)
    const templateName = name ?? extractBpmnProcessName(xml) ?? 'Imported Workflow'

    const teamId = await resolveDefaultTeamId(req.user!.userId)
    const template = await prisma.workflow.create({
      data: { name: templateName, createdById: req.user!.userId, teamId, currentVersion: 1 },
    })
    await prisma.workflowVersion.create({
      data: { templateId: template.id, version: 1, graphSnapshot: snapshot as any },
    })
    const full = await prisma.workflow.findUnique({ where: { id: template.id }, include: { versions: true } })
    await logEvent('TemplateImportedBpmn', 'WorkflowTemplate', template.id, req.user!.userId, { name: templateName })
    res.status(201).json(full)
  } catch (err) { next(err) }
})

// ─── BPMN helpers ─────────────────────────────────────────────────────────────

const BPMN_NODE_MAP: Record<string, string> = {
  HUMAN_TASK: 'userTask', AGENT_TASK: 'serviceTask', WORKBENCH_TASK: 'serviceTask', APPROVAL: 'userTask',
  TOOL_REQUEST: 'serviceTask', POLICY_CHECK: 'serviceTask', DATA_SINK: 'serviceTask',
  CONSUMABLE_CREATION: 'serviceTask', CALL_WORKFLOW: 'callActivity', WORK_ITEM: 'serviceTask',
  FOREACH: 'subProcess', TIMER: 'intermediateCatchEvent',
  SIGNAL_WAIT: 'intermediateCatchEvent', DECISION_GATE: 'exclusiveGateway',
  INCLUSIVE_GATEWAY: 'inclusiveGateway', EVENT_GATEWAY: 'eventBasedGateway',
}

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function templateToBpmn(name: string, id: string, snapshot: { nodes?: any[]; edges?: any[] }): string {
  const nodes: any[] = snapshot.nodes ?? []
  const edges: any[] = snapshot.edges ?? []
  const pid = `Process_${id.replace(/-/g, '_').slice(0, 16)}`

  const elements = nodes.map((n: any) => {
    const bpmnType = BPMN_NODE_MAP[n.nodeType] ?? 'task'
    const ext = `<bpmn2:extensionElements><wg:workGraphNode nodeType="${n.nodeType}" label="${escapeXml(n.label ?? '')}"/></bpmn2:extensionElements>`
    if (bpmnType === 'intermediateCatchEvent' && n.nodeType === 'TIMER') {
      return `<bpmn2:intermediateCatchEvent id="${n.id}" name="${escapeXml(n.label)}">${ext}<bpmn2:timerEventDefinition/></bpmn2:intermediateCatchEvent>`
    }
    if (bpmnType === 'intermediateCatchEvent' && n.nodeType === 'SIGNAL_WAIT') {
      return `<bpmn2:intermediateCatchEvent id="${n.id}" name="${escapeXml(n.label)}">${ext}<bpmn2:signalEventDefinition/></bpmn2:intermediateCatchEvent>`
    }
    if (bpmnType === 'subProcess') {
      return `<bpmn2:subProcess id="${n.id}" name="${escapeXml(n.label)}" triggeredByEvent="false">${ext}</bpmn2:subProcess>`
    }
    return `<bpmn2:${bpmnType} id="${n.id}" name="${escapeXml(n.label)}">${ext}</bpmn2:${bpmnType}>`
  })

  const flows = edges.map((e: any) =>
    `<bpmn2:sequenceFlow id="${e.id}" sourceRef="${e.sourceNodeId}" targetRef="${e.targetNodeId}"${e.label ? ` name="${escapeXml(e.label)}"` : ''}/>`,
  )

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions
  xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:wg="https://workgraph.io/bpmn/extension"
  id="Definitions_${id.slice(0, 8)}"
  targetNamespace="https://workgraph.io/bpmn"
  exporter="WorkGraph Studio" exporterVersion="1.0">
  <bpmn2:process id="${pid}" name="${escapeXml(name)}" isExecutable="true">
    ${elements.join('\n    ')}
    ${flows.join('\n    ')}
  </bpmn2:process>
</bpmn2:definitions>`
}

function extractBpmnProcessName(xml: string): string | null {
  const m = xml.match(/bpmn2?:process[^>]+name="([^"]+)"/)
  return m?.[1] ?? null
}

function bpmnToSnapshot(xml: string): { nodes: any[]; edges: any[] } {
  const BPMN_REVERSE: Record<string, string> = {
    userTask: 'HUMAN_TASK', serviceTask: 'AGENT_TASK', callActivity: 'CALL_WORKFLOW',
    subProcess: 'FOREACH', exclusiveGateway: 'DECISION_GATE',
    inclusiveGateway: 'INCLUSIVE_GATEWAY', eventBasedGateway: 'EVENT_GATEWAY',
  }

  const nodes: any[] = []
  const edges: any[] = []
  let x = 100, y = 100

  // Extract wg:workGraphNode extension attrs for precise type
  const extRegex = /<wg:workGraphNode\s+nodeType="([^"]+)"\s+label="([^"]*)"/g
  const extMap: Record<string, { nodeType: string; label: string }> = {}
  let em: RegExpExecArray | null
  while ((em = extRegex.exec(xml)) !== null) {
    // We'll correlate by position — captured separately
  }

  // Parse bpmn elements
  const elemRegex = /<bpmn2?:(\w+)\s+id="([^"]+)"[^>]*name="([^"]*)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = elemRegex.exec(xml)) !== null) {
    const [, bpmnType, id, name] = m
    if (bpmnType === 'process' || bpmnType === 'definitions') continue

    if (bpmnType === 'sequenceFlow') {
      const srcM = m[0].match(/sourceRef="([^"]+)"/)
      const tgtM = m[0].match(/targetRef="([^"]+)"/)
      if (srcM && tgtM) edges.push({ id, sourceNodeId: srcM[1], targetNodeId: tgtM[1], edgeType: 'SEQUENTIAL', label: name || undefined })
      continue
    }

    const nodeType = BPMN_REVERSE[bpmnType] ?? 'HUMAN_TASK'
    nodes.push({ id, label: name || bpmnType, nodeType, positionX: x, positionY: y, config: {} })
    x += 200
    if (x > 1200) { x = 100; y += 150 }
  }

  return { nodes, edges }
}

// ─── Per-template Permissions (Gap #19) ───────────────────────────────────────

const grantPermissionSchema = z.object({
  roleId: z.string().uuid(),
  action: z.enum(['VIEW', 'EDIT', 'START', 'ADMIN']),
})

workflowTemplatesRouter.get('/:id/permissions', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const template = await prisma.workflow.findUnique({ where: { id } })
    if (!template) throw new NotFoundError('WorkflowTemplate', id)

    const permissions = await prisma.workflowPermission.findMany({
      where: { templateId: id },
      orderBy: { grantedAt: 'asc' },
    })
    res.json(permissions)
  } catch (err) {
    next(err)
  }
})

workflowTemplatesRouter.post('/:id/permissions', validate(grantPermissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const template = await prisma.workflow.findUnique({ where: { id } })
    if (!template) throw new NotFoundError('WorkflowTemplate', id)

    const { roleId, action } = req.body as z.infer<typeof grantPermissionSchema>
    const perm = await prisma.workflowPermission.upsert({
      where: { templateId_roleId_action: { templateId: id, roleId, action } },
      create: { templateId: id, roleId, action },
      update: { grantedAt: new Date() },
    })
    res.status(201).json(perm)
  } catch (err) {
    next(err)
  }
})

workflowTemplatesRouter.delete('/:id/permissions/:permId', async (req, res, next) => {
  try {
    await prisma.workflowPermission.delete({ where: { id: req.params.permId as string } })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
