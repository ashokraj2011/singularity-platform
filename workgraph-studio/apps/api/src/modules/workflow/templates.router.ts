import { Router } from 'express'
import { z } from 'zod'
import { Prisma, NodeType } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, publishOutbox } from '../../lib/audit'
import { assertTemplatePermission, resolveDefaultTeamId } from '../../lib/permissions/workflowTemplate'
import { getDesignInstanceId } from './lib/cloneDesignToRun'
import { validateNodeConfig } from '../lookup/resolver'
import { listAgentTemplates, type AgentTemplate } from '../../lib/agent-and-tools/client'
import { normalizeBudgetPolicy } from './runtime/budget'
import { resolveTeamIdForWorkflow, tokenFromAuthorizationHeader } from '../../lib/iam/teamMirror'
import { analyzeWorkflowTemplate } from './formal-verification'
import { normalizeMetadataKey, resolveMetadataSnapshot } from '../metadata/metadata.service'
import { SDLC_INTENTS } from '../adoption/sdlcCatalog'

export const workflowTemplatesRouter: Router = Router()

workflowTemplatesRouter.post('/:id/formal-analysis', async (req, res, next) => {
  try {
    await assertTemplatePermission(req.user!.userId, req.params.id, 'view')
    const analysis = await analyzeWorkflowTemplate(req.params.id, req.user!.userId)
    res.json({ data: analysis })
  } catch (err) {
    next(err)
  }
})

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

const GOVERNANCE_MODES = ['fail_open', 'fail_closed', 'degraded', 'human_approval_required'] as const
type GovernanceMode = typeof GOVERNANCE_MODES[number]

const variableDefSchema = z.object({
  key:          z.string().min(1).max(80).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Key must be a valid identifier'),
  label:        z.string().optional(),
  type:         z.enum(['STRING', 'NUMBER', 'BOOLEAN', 'JSON']).default('STRING'),
  defaultValue: z.unknown().optional(),
  description:  z.string().optional(),
  scope:        z.enum(['INPUT', 'CONSTANT']).default('INPUT'),
})

const routingModes = ['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START'] as const

const createTemplateSchema = z.object({
  name:         z.string().min(1),
  description:  z.string().optional(),
  teamId:       z.string().optional(),
  // ID of the owning capability in Singularity IAM.  When set, this is the
  // authorization boundary for view/edit/start checks.
  capabilityId: z.string().optional(),
  workflowTypeKey: z.string().optional(),
  eligibleWorkItemTypes: z.array(z.string()).optional(),
  isDefaultForType: z.boolean().optional(),
  defaultRoutingMode: z.enum(routingModes).optional(),
  metadata:     metadataSchema,
  variables:    z.array(variableDefSchema).optional(),
  budgetPolicy: z.record(z.unknown()).optional(),
  // CAPABILITY_WORKBENCH_BRIDGE → 4-stage loop (Intake → Design → Develop → QA)
  starter:      z.enum(['EMPTY', 'CAPABILITY_WORKBENCH_BRIDGE']).optional(),
  // M85.s2 — workflow profile. 'main' = top-level orchestration
  // (default). 'workbench' = standalone agent-loop template; its
  // nodes are stages and the M84 WorkbenchDefinition tables are
  // attached to the template itself. blueprint-workbench only
  // renders 'workbench' instances; the main workflow designer
  // shows workbench-only node types only on 'workbench' templates.
  profile:      z.enum(['main', 'workbench']).default('main').optional(),
})

const updateTemplateSchema = z.object({
  name:         z.string().min(1).optional(),
  description:  z.string().optional(),
  teamId:       z.string().optional(),
  capabilityId: z.string().nullable().optional(),
  workflowTypeKey: z.string().optional(),
  eligibleWorkItemTypes: z.array(z.string()).optional(),
  isDefaultForType: z.boolean().optional(),
  defaultRoutingMode: z.enum(routingModes).optional(),
  metadata:     metadataSchema,
  variables:    z.array(variableDefSchema).optional(),
  budgetPolicy: z.record(z.unknown()).nullable().optional(),
  // M85.s2 introduced the profile column but only the create route set it.
  // Allow editing it so a workflow can be moved between Main and Workbench
  // without hand-editing the DB (e.g. a template that embeds a WORKBENCH_TASK
  // must be 'workbench' for blueprint-workbench's M85.s5 guard to open it).
  profile:      z.enum(['main', 'workbench']).optional(),
})

function withTemplateGovernanceDefaults(budgetPolicy: unknown, metadata: unknown): Record<string, unknown> {
  const raw = isRecord(budgetPolicy) ? { ...budgetPolicy } : {}
  if (!isGovernanceMode(raw.governanceMode)) {
    const defaultMode = defaultGovernanceModeForMetadata(metadata)
    if (defaultMode) raw.governanceMode = defaultMode
  }
  return raw
}

function defaultGovernanceModeForMetadata(metadata: unknown): GovernanceMode | undefined {
  const meta = isRecord(metadata) ? metadata : {}
  const workflowType = String(meta.workflowType ?? '').toUpperCase()
  const dataSensitivity = String(meta.dataSensitivity ?? '').toUpperCase()
  const criticality = String(meta.criticality ?? meta.risk ?? '').toUpperCase()
  if (workflowType === 'COMPLIANCE' || dataSensitivity === 'RESTRICTED') return 'fail_closed'
  if (criticality === 'HIGH' || criticality === 'CRITICAL' || criticality === 'SOX' || criticality === 'PCI') {
    return 'human_approval_required'
  }
  if (meta.requiresApprovalToRun === true) return 'human_approval_required'
  return undefined
}

function isGovernanceMode(value: unknown): value is GovernanceMode {
  return typeof value === 'string' && (GOVERNANCE_MODES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

workflowTemplatesRouter.post('/', validate(createTemplateSchema), async (req, res, next) => {
  try {
    const { name, description, teamId, capabilityId, workflowTypeKey: rawWorkflowTypeKey, eligibleWorkItemTypes, isDefaultForType, defaultRoutingMode, metadata, variables, budgetPolicy, starter, profile } =
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
    const workflowTypeKey = normalizeMetadataKey(rawWorkflowTypeKey ?? metadata?.workflowType)
    const typeMeta = await resolveMetadataSnapshot({
      kind: 'WORKFLOW_TYPE',
      key: workflowTypeKey,
      capabilityId: capabilityId ?? null,
    })

    const template = await prisma.workflow.create({
      data: {
        name, description,
        teamId:       ownerTeamId,
        capabilityId: capabilityId ?? null,
        createdById:  req.user!.userId,
        workflowTypeKey,
        typeVersion: typeMeta.version,
        typeSnapshot: typeMeta.snapshot as any ?? undefined,
        eligibleWorkItemTypes: (eligibleWorkItemTypes ?? []) as unknown as Prisma.InputJsonValue,
        isDefaultForType: isDefaultForType ?? false,
        defaultRoutingMode: defaultRoutingMode ?? 'MANUAL',
        metadata:     metadata as any ?? {},
        variables:    normalizedVariables as unknown as Prisma.InputJsonValue,
        budgetPolicy: normalizeBudgetPolicy(withTemplateGovernanceDefaults(budgetPolicy, metadata)) as unknown as Prisma.InputJsonValue,
        profile:      profile ?? 'main',
      },
    })

    if (starter === 'CAPABILITY_WORKBENCH_BRIDGE') {
      await createCapabilityWorkbenchBridgeGraph({
        workflowId: template.id,
        capabilityId: capabilityId ?? '',
        actorId: req.user!.userId,
        authHeader: req.headers.authorization,
        goal: description?.trim() || name,
        // M94.3 — fields needed to spawn the child workbench-profile
        // workflow in multinode mode. Harmless in single-node mode.
        parentName: name,
        teamId: ownerTeamId,
        workflowTypeKey,
        metadata,
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
  parentName,
  teamId,
  workflowTypeKey,
  metadata,
}: {
  workflowId: string
  capabilityId: string
  actorId: string
  authHeader?: string
  goal: string
  // M94.3 — present only from the create handler; used to spawn the
  // child workbench-profile workflow in multinode mode.
  parentName?: string
  teamId?: string | null
  workflowTypeKey?: string
  metadata?: unknown
}) {
  const { bindings, warnings } = await resolveStarterAgentBindings(capabilityId, authHeader)
  const workbenchGoal = goal || 'Produce an approved implementation contract pack.'
  const workbenchConfig = buildWorkbenchConfig(capabilityId, bindings, workbenchGoal)

  // M94.3 (2026-05-28) — ⚠️ NOT RUNTIME-VERIFIED. Multinode graph shape.
  //
  // When WORKBENCH_MULTINODE=true, the agentic starter produces the
  // operator-requested "phases as nodes" layout: a profile=workbench
  // CHILD workflow whose canvas is START → Story Intake → Design →
  // Develop → QA → END (each a WORKBENCH_TASK pinned to one stageKey via
  // config.workbench.stageKey), plus a MAIN workflow that dispatches it:
  // START → CALL_WORKFLOW(child) → APPROVAL → GIT_PUSH → END. M85.s4 makes
  // the child instance inherit profile=workbench at spawn; M94.1's
  // shared-session resolution threads one BlueprintSession across the
  // four stage nodes; M94.2's verdict hook completes each node as its
  // stage is accepted.
  //
  // When off, the existing single-node graph (one opaque WORKBENCH_TASK
  // holding the 4-stage loopDefinition) is built — byte-for-byte the
  // pre-M94 behavior.
  const multinode = (process.env.WORKBENCH_MULTINODE ?? '').toLowerCase() === 'true'
  // The child workflow needs a non-null teamId (Workflow.teamId is
  // required). The main workflow was just created with a resolved
  // ownerTeamId, which the create handler threads here; only build the
  // multinode bridge when we actually have one. Fall through to the
  // single-node graph otherwise so the starter never hard-fails.
  if (multinode && teamId) {
    await buildMultinodeWorkbenchBridge({
      mainWorkflowId: workflowId,
      capabilityId,
      actorId,
      goal: workbenchGoal,
      bindings,
      warnings,
      workbenchConfig,
      parentName: parentName ?? 'Workbench',
      teamId,
      workflowTypeKey: workflowTypeKey ?? 'GENERAL',
      metadata,
    })
    return
  }

  const [startNode, workbenchNode, approvalNode, gitPushNode, endNode] = await prisma.$transaction(async tx => {
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
    // M37.1 — GIT_PUSH after APPROVAL. The blueprint Developer stage may have
    // produced commits on an isolated work-branch in mcp-server's per-WorkItem
    // sandbox (e.g. `sg/<instance>/develop/<n>-<hash>`), but mcp-server commits
    // locally and does NOT push by default. Without this node, the human-
    // approved diff never reaches the upstream git remote — the operator has
    // to push manually from the container. Adding a deterministic GIT_PUSH
    // node closes that gap: the executor calls mcp-server's purpose-built
    // /mcp/work/finish-branch endpoint with push:true, gated on the upstream
    // APPROVAL node already firing (requireApproval defaults to true).
    const gitPush = await tx.workflowDesignNode.create({
      data: {
        workflowId,
        nodeType: 'GIT_PUSH' as any,
        label: 'Push approved branch',
        config: {
          remote: 'origin',
          requireApproval: true,
          // branchName / workItemId / workItemCode are auto-detected at runtime
          // by GitPushExecutor from the workspaceBranch evidence + workItem
          // context; the executor falls back to `work/<workItemCode>` when no
          // evidence is found. No explicit branchName here lets the runtime
          // pick up the actual `sg/...` branch the agent created.
        } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 870,
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
        positionX: 1130,
        positionY: 220,
      },
    })
    await tx.workflowDesignEdge.createMany({
      data: [
        { workflowId, sourceNodeId: start.id,     targetNodeId: workbench.id, edgeType: 'SEQUENTIAL' as any },
        { workflowId, sourceNodeId: workbench.id, targetNodeId: approval.id,  edgeType: 'SEQUENTIAL' as any },
        { workflowId, sourceNodeId: approval.id,  targetNodeId: gitPush.id,   edgeType: 'SEQUENTIAL' as any },
        { workflowId, sourceNodeId: gitPush.id,   targetNodeId: end.id,       edgeType: 'SEQUENTIAL' as any },
      ],
    })
    return [start, workbench, approval, gitPush, end] as const
  })

  await logEvent('WorkflowStarterApplied', 'Workflow', workflowId, actorId, {
    starter: 'CAPABILITY_WORKBENCH_BRIDGE',
    capabilityId,
    nodeIds: {
      start: startNode.id,
      workbench: workbenchNode.id,
      approval: approvalNode.id,
      gitPush: gitPushNode.id,
      end: endNode.id,
    },
    warnings,
  })
}

// M94.3 (2026-05-28) — ⚠️ NOT RUNTIME-VERIFIED. Multinode bridge builder.
//
// Produces the operator-requested "phases as nodes" layout:
//
//   CHILD (profile=workbench):
//     START → Story Intake → Design → Develop → QA → END
//     (each phase a WORKBENCH_TASK pinned to one stageKey via
//      config.workbench.stageKey; every node carries the FULL 4-stage
//      loopDefinition so whichever activates first seeds the shared
//      session — M94.1 — with all stages, then each node owns its slice)
//
//   MAIN (the already-created workflowId, profile=main):
//     START → CALL_WORKFLOW(child) → APPROVAL → GIT_PUSH → END
//     (CALL_WORKFLOW target lives in config.standard.templateId, which is
//      what CallWorkflowExecutor reads; M85.s4 makes the spawned child
//      instance inherit profile=workbench)
//
// The whole branch is inert unless WORKBENCH_MULTINODE=true (checked by
// the caller). ⚠️ The runtime threading (M94.1 session share + M94.2
// per-node completion) has NOT been verified against a running stack.
async function buildMultinodeWorkbenchBridge({
  mainWorkflowId,
  capabilityId,
  actorId,
  bindings,
  warnings,
  workbenchConfig,
  parentName,
  teamId,
  workflowTypeKey,
  metadata,
}: {
  mainWorkflowId: string
  capabilityId: string
  actorId: string
  goal: string
  bindings: StarterAgentBindings
  warnings: string[]
  workbenchConfig: ReturnType<typeof buildWorkbenchConfig>
  parentName: string
  teamId: string
  workflowTypeKey: string
  metadata?: unknown
}) {
  // Stages come straight off the canonical loopDefinition so the node
  // chain matches the loop (Story Intake → Design → Develop → QA).
  const stages = workbenchConfig.loopDefinition.stages

  // 1. Create the CHILD workbench-profile workflow row.
  const child = await prisma.workflow.create({
    data: {
      name: `${parentName} — Workbench`,
      description: 'Agent-loop sub-workflow (Story Intake → Design → Develop → QA). Dispatched by the parent main workflow.',
      teamId,
      capabilityId: capabilityId || null,
      createdById: actorId,
      workflowTypeKey,
      defaultRoutingMode: 'MANUAL',
      metadata: (metadata as Prisma.InputJsonValue) ?? {},
      profile: 'workbench',
    },
  })

  // 2. Build the CHILD graph: START → <stage nodes> → END.
  await prisma.$transaction(async tx => {
    const childStart = await tx.workflowDesignNode.create({
      data: {
        workflowId: child.id,
        nodeType: 'START' as any,
        label: 'Start',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: 80,
        positionY: 220,
      },
    })

    let prevId = childStart.id
    let x = 320
    const stageNodeIds: Record<string, string> = {}
    for (const stage of stages) {
      const stageNode = await tx.workflowDesignNode.create({
        data: {
          workflowId: child.id,
          nodeType: 'WORKBENCH_TASK' as any,
          label: String(stage.label ?? stage.key),
          config: {
            assignmentMode: 'DIRECT_USER',
            assignedToId: actorId,
            // Full loopDefinition on every node so the first to activate
            // seeds the shared session with all stages (M94.1); stageKey
            // pins WHICH stage this node owns (M94.2 verdict hook reads it).
            workbench: { ...workbenchConfig, stageKey: stage.key, multinode: true },
            outputArtifacts: workbenchOutputBindings(),
            starterWarnings: warnings,
          } as Prisma.InputJsonValue,
          executionLocation: 'SERVER' as any,
          positionX: x,
          positionY: 220,
        },
      })
      stageNodeIds[stage.key] = stageNode.id
      await tx.workflowDesignEdge.create({
        data: { workflowId: child.id, sourceNodeId: prevId, targetNodeId: stageNode.id, edgeType: 'SEQUENTIAL' as any },
      })
      prevId = stageNode.id
      x += 250
    }

    const childEnd = await tx.workflowDesignNode.create({
      data: {
        workflowId: child.id,
        nodeType: 'END' as any,
        label: 'Done',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: x,
        positionY: 220,
      },
    })
    await tx.workflowDesignEdge.create({
      data: { workflowId: child.id, sourceNodeId: prevId, targetNodeId: childEnd.id, edgeType: 'SEQUENTIAL' as any },
    })
  })

  // 3. Build the MAIN graph: START → CALL_WORKFLOW(child) → APPROVAL → GIT_PUSH → END.
  await prisma.$transaction(async tx => {
    const start = await tx.workflowDesignNode.create({
      data: {
        workflowId: mainWorkflowId,
        nodeType: 'START' as any,
        label: 'Start',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: 80,
        positionY: 220,
      },
    })
    const callChild = await tx.workflowDesignNode.create({
      data: {
        workflowId: mainWorkflowId,
        nodeType: 'CALL_WORKFLOW' as any,
        label: 'Run agent workbench',
        // CallWorkflowExecutor reads templateId from config.standard.templateId.
        config: { standard: { templateId: child.id } } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 330,
        positionY: 220,
      },
    })
    const approval = await tx.workflowDesignNode.create({
      data: {
        workflowId: mainWorkflowId,
        nodeType: 'APPROVAL' as any,
        label: 'Human final sign-off',
        config: {
          assignmentMode: 'DIRECT_USER',
          assignedToId: actorId,
          subject: 'Blueprint final implementation pack',
          formWidgets: [
            { id: 'approvalNotes', type: 'textarea', label: 'Approval notes', required: false, placeholder: 'Capture rollout conditions, risk acceptance, or follow-up work.' },
          ],
        } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 610,
        positionY: 220,
      },
    })
    const gitPush = await tx.workflowDesignNode.create({
      data: {
        workflowId: mainWorkflowId,
        nodeType: 'GIT_PUSH' as any,
        label: 'Push approved branch',
        config: { remote: 'origin', requireApproval: true } as Prisma.InputJsonValue,
        executionLocation: 'SERVER' as any,
        positionX: 870,
        positionY: 220,
      },
    })
    const end = await tx.workflowDesignNode.create({
      data: {
        workflowId: mainWorkflowId,
        nodeType: 'END' as any,
        label: 'Done',
        config: {},
        executionLocation: 'SERVER' as any,
        positionX: 1130,
        positionY: 220,
      },
    })
    await tx.workflowDesignEdge.createMany({
      data: [
        { workflowId: mainWorkflowId, sourceNodeId: start.id,     targetNodeId: callChild.id, edgeType: 'SEQUENTIAL' as any },
        { workflowId: mainWorkflowId, sourceNodeId: callChild.id, targetNodeId: approval.id,  edgeType: 'SEQUENTIAL' as any },
        { workflowId: mainWorkflowId, sourceNodeId: approval.id,  targetNodeId: gitPush.id,   edgeType: 'SEQUENTIAL' as any },
        { workflowId: mainWorkflowId, sourceNodeId: gitPush.id,   targetNodeId: end.id,       edgeType: 'SEQUENTIAL' as any },
      ],
    })
  })

  await logEvent('WorkflowStarterApplied', 'Workflow', mainWorkflowId, actorId, {
    starter: 'CAPABILITY_WORKBENCH_BRIDGE',
    multinode: true,
    capabilityId,
    childWorkflowId: child.id,
    childStageCount: stages.length,
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

// Canonical Workbench loop — 4 stages: STORY_INTAKE → DESIGN → DEVELOP → QA.
//
// This was previously an 8-stage flow (Intake → Plan → Design → Develop →
// Security Review → QA Review → Release Readiness → Test Certification). The
// trimmed-down 4-stage version is now the only flow created by the starter,
// because the extra stages (Plan/Security/Release/Cert) lack role-specific
// prompts in prompt-composer and collapsed onto the generic loopDefaultTask,
// which wasted ~4× the tokens and produced overlapping output that the next
// stage rejected as duplicate.
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
      maxTotalSendBacks: 6,
      stages: [
        {
          key: 'STORY_INTAKE',
          label: 'Story Intake',
          agentRole: 'PRODUCT_OWNER',
          agentTemplateId: bindings.productOwnerAgentTemplateId || bindings.architectAgentTemplateId,
          next: 'DESIGN',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: [],
          expectedArtifacts: [
            { kind: 'story_brief', title: 'Story brief', required: true, format: 'MARKDOWN' },
            { kind: 'acceptance_contract', title: 'Acceptance contract', required: true, format: 'MARKDOWN' },
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
          allowedSendBackTo: ['STORY_INTAKE'],
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
          next: 'QA',
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['STORY_INTAKE', 'DESIGN'],
          expectedArtifacts: [
            { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
            { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', required: true, format: 'MARKDOWN' },
          ],
        },
        {
          key: 'QA',
          label: 'QA',
          agentRole: 'QA',
          agentTemplateId: bindings.qaAgentTemplateId,
          terminal: true,
          required: true,
          approvalRequired: true,
          allowedSendBackTo: ['DESIGN', 'DEVELOP'],
          expectedArtifacts: [
            { kind: 'qa_task_pack', title: 'QA review pack', required: true, format: 'MARKDOWN' },
            { kind: 'verification_rules', title: 'Verification rules', required: true, format: 'MARKDOWN' },
            { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
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
    throw new ValidationError('Workflow runs must start from a WorkItem. Claim or create a WorkItem, then attach this workflow from the WorkItem queue.')
  } catch (err) { next(err) }
})

// GET /workflow-templates/:id/runs — list executions for a template.
workflowTemplatesRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'view')
    const runs = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findMany({
      where:   { templateId: id },
      orderBy: { createdAt: 'desc' },
      select:  {
        id: true, name: true, status: true,
        templateVersion: true,
        createdAt: true, startedAt: true, completedAt: true,
      },
    }))
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
        nodeTypeKey: n.nodeTypeKey, nodeTypeVersion: n.nodeTypeVersion, nodeTypeSnapshot: n.nodeTypeSnapshot,
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
  nodeType:          z.nativeEnum(NodeType),
  nodeTypeKey:       z.string().optional(),
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
    // Ownership: the phase must belong to THIS workflow — edit perm on :id must
    // not let a caller mutate another workflow's phase by bare id.
    const owned = await prisma.workflowDesignPhase.findFirst({ where: { id: phaseId, workflowId: id }, select: { id: true } })
    if (!owned) throw new NotFoundError('WorkflowDesignPhase', phaseId)
    const updated = await prisma.workflowDesignPhase.update({ where: { id: phaseId }, data: req.body })
    res.json(updated)
  } catch (err) { next(err) }
})
workflowTemplatesRouter.delete('/:id/design/phases/:phaseId', async (req, res, next) => {
  try {
    const id      = req.params.id as string
    const phaseId = req.params.phaseId as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    // Ownership: scope the delete to THIS workflow (see PATCH above).
    const { count } = await prisma.workflowDesignPhase.deleteMany({ where: { id: phaseId, workflowId: id } })
    if (count === 0) throw new NotFoundError('WorkflowDesignPhase', phaseId)
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

    const nodeTypeKey = normalizeMetadataKey(body.nodeTypeKey ?? (body.config?._customTypeId as string | undefined) ?? body.nodeType, String(body.nodeType))
    const nodeMeta = await resolveMetadataSnapshot({ kind: 'NODE_TYPE', key: nodeTypeKey, workflowId: id })
    const created = await prisma.workflowDesignNode.create({
      data: {
        workflowId:        id,
        phaseId:           body.phaseId ?? null,
        nodeType:          body.nodeType as any,
        nodeTypeKey,
        nodeTypeVersion:   nodeMeta.version,
        nodeTypeSnapshot:  nodeMeta.snapshot as any ?? undefined,
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
    // Ownership: the node must belong to THIS workflow. Guards every path below
    // (including position-only patches that skip the config/metadata re-fetch).
    const ownedNode = await prisma.workflowDesignNode.findFirst({ where: { id: nodeId, workflowId: id }, select: { id: true } })
    if (!ownedNode) throw new NotFoundError('WorkflowDesignNode', nodeId)
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

    let nodeMetadataPatch: Record<string, unknown> = {}
    if (body.nodeType !== undefined || body.config !== undefined || body.nodeTypeKey !== undefined) {
      const existing = await prisma.workflowDesignNode.findUnique({ where: { id: nodeId }, select: { nodeType: true, config: true } })
      if (!existing) throw new NotFoundError('WorkflowDesignNode', nodeId)
      const effectiveType = String(body.nodeType ?? existing.nodeType)
      const effectiveConfig = (body.config !== undefined ? body.config : existing.config) as Record<string, unknown> | null
      const nodeTypeKey = normalizeMetadataKey(body.nodeTypeKey ?? effectiveConfig?._customTypeId ?? effectiveType, effectiveType)
      const nodeMeta = await resolveMetadataSnapshot({ kind: 'NODE_TYPE', key: nodeTypeKey, workflowId: id })
      nodeMetadataPatch = {
        nodeTypeKey,
        nodeTypeVersion: nodeMeta.version,
        nodeTypeSnapshot: nodeMeta.snapshot ?? Prisma.JsonNull,
      }
    }

    const updated = await prisma.workflowDesignNode.update({
      where: { id: nodeId },
      data: ({
        ...nodeMetadataPatch,
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
    // Ownership: scope the delete to THIS workflow.
    const { count } = await prisma.workflowDesignNode.deleteMany({ where: { id: nodeId, workflowId: id } })
    if (count === 0) throw new NotFoundError('WorkflowDesignNode', nodeId)
    res.status(204).end()
  } catch (err) { next(err) }
})

// Edges
workflowTemplatesRouter.post('/:id/design/edges', validate(designEdgeBodySchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof designEdgeBodySchema>
    // Ownership: both endpoints must be nodes of THIS workflow — otherwise a
    // caller could wire an edge into another workflow's node by bare id.
    const endpoints = await prisma.workflowDesignNode.findMany({
      where: { workflowId: id, id: { in: [body.sourceNodeId, body.targetNodeId] } },
      select: { id: true },
    })
    const endpointIds = new Set(endpoints.map(n => n.id))
    if (!endpointIds.has(body.sourceNodeId) || !endpointIds.has(body.targetNodeId)) {
      throw new ValidationError('Edge source and target must both be nodes of this workflow')
    }
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
    // Ownership: the edge must belong to THIS workflow.
    const ownedEdge = await prisma.workflowDesignEdge.findFirst({ where: { id: edgeId, workflowId: id }, select: { id: true } })
    if (!ownedEdge) throw new NotFoundError('WorkflowDesignEdge', edgeId)
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
    // Ownership: scope the delete to THIS workflow.
    const { count } = await prisma.workflowDesignEdge.deleteMany({ where: { id: edgeId, workflowId: id } })
    if (count === 0) throw new NotFoundError('WorkflowDesignEdge', edgeId)
    res.status(204).end()
  } catch (err) { next(err) }
})

workflowTemplatesRouter.patch('/:id', validate(updateTemplateSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const existingWorkflow = await assertTemplatePermission(req.user!.userId, id, 'edit')
    const body = req.body as z.infer<typeof updateTemplateSchema>
    const capabilityIdForMetadata = body.capabilityId !== undefined ? body.capabilityId : existingWorkflow.capabilityId

    const resolvedTeamId = body.teamId !== undefined
      ? await resolveTeamIdForWorkflow(body.teamId, tokenFromAuthorizationHeader(req.headers.authorization))
      : undefined
    const existingForBudgetDefaults = body.budgetPolicy !== undefined && body.metadata === undefined
      ? await prisma.workflow.findUnique({ where: { id }, select: { metadata: true } })
      : null
    const metadataForBudgetDefaults = body.metadata ?? existingForBudgetDefaults?.metadata
    const requestedWorkflowTypeKey = body.workflowTypeKey ?? body.metadata?.workflowType
    const typeMeta = requestedWorkflowTypeKey
      ? await resolveMetadataSnapshot({
        kind: 'WORKFLOW_TYPE',
        key: normalizeMetadataKey(requestedWorkflowTypeKey),
        capabilityId: capabilityIdForMetadata ?? undefined,
      })
      : null

    const t = await prisma.workflow.update({
      where: { id },
      data: {
        ...(body.name         !== undefined ? { name:         body.name }                                              : {}),
        ...(body.description  !== undefined ? { description:  body.description }                                       : {}),
        ...(resolvedTeamId    !== undefined ? { teamId:       resolvedTeamId }                                        : {}),
        ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId }                                      : {}),
        ...(requestedWorkflowTypeKey !== undefined ? {
          workflowTypeKey: normalizeMetadataKey(requestedWorkflowTypeKey),
          typeVersion: typeMeta?.version ?? 1,
          typeSnapshot: typeMeta?.snapshot as any ?? Prisma.JsonNull,
        } : {}),
        ...(body.eligibleWorkItemTypes !== undefined ? { eligibleWorkItemTypes: body.eligibleWorkItemTypes as unknown as Prisma.InputJsonValue } : {}),
        ...(body.isDefaultForType !== undefined ? { isDefaultForType: body.isDefaultForType } : {}),
        ...(body.defaultRoutingMode !== undefined ? { defaultRoutingMode: body.defaultRoutingMode } : {}),
        ...(body.metadata     !== undefined ? { metadata:     body.metadata as any }                                   : {}),
        ...(body.variables    !== undefined ? { variables:    body.variables as unknown as Prisma.InputJsonValue }     : {}),
        ...(body.budgetPolicy !== undefined ? { budgetPolicy: normalizeBudgetPolicy(withTemplateGovernanceDefaults(body.budgetPolicy, metadataForBudgetDefaults)) as unknown as Prisma.InputJsonValue } : {}),
        ...(body.profile      !== undefined ? { profile:      body.profile }                                            : {}),
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
    const workflowTypeKey = typeof req.query.workflowTypeKey === 'string' && req.query.workflowTypeKey.trim()
      ? normalizeMetadataKey(req.query.workflowTypeKey)
      : undefined
    // M85.s2 — profile filter. Accepts 'main', 'workbench', or a
    // comma-separated combination (e.g. ?profile=main,workbench
    // returns both). Absent → returns everything (back-compat).
    const profileRaw = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : undefined
    const profileFilter = profileRaw
      ? profileRaw.split(',').map(p => p.trim()).filter(Boolean)
      : undefined
    const where: Prisma.WorkflowWhereInput = {
      archivedAt: showArchived ? { not: null } : null,
      ...(capabilityId ? { capabilityId } : {}),
      ...(workflowTypeKey ? { workflowTypeKey } : {}),
      ...(profileFilter && profileFilter.length > 0 ? { profile: { in: profileFilter } } : {}),
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

workflowTemplatesRouter.get('/gallery', async (req, res, next) => {
  try {
    const capabilityId = typeof req.query.capabilityId === 'string' && req.query.capabilityId.trim()
      ? req.query.capabilityId.trim()
      : undefined
    const templates = await prisma.workflow.findMany({
      where: {
        archivedAt: null,
        profile: 'main',
        ...(capabilityId ? { capabilityId } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        capabilityId: true,
        workflowTypeKey: true,
        defaultRoutingMode: true,
        metadata: true,
        variables: true,
        profile: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ isDefaultForType: 'desc' }, { name: 'asc' }],
    })

    const items = SDLC_INTENTS.map(intent => {
      const ranked = templates
        .map(template => {
          const workflowTypeKey = normalizeMetadataKey(template.workflowTypeKey)
          const typeRank = intent.workflowTypeKeys.indexOf(workflowTypeKey)
          const name = template.name.toLowerCase()
          const labelWords = intent.label.toLowerCase().split(/\s+/)
          const nameMatch = labelWords.filter(word => name.includes(word)).length
          const score = (typeRank >= 0 ? 100 - typeRank : 0) + (nameMatch * 10)
          return { template, score }
        })
        .filter(row => row.score > 0)
        .sort((left, right) => right.score - left.score || left.template.name.localeCompare(right.template.name))
        .map(row => row.template)
      return {
        ...intent,
        templates: ranked.slice(0, 3),
        workflowTemplate: ranked[0] ?? null,
        templateCount: ranked.length,
        runtimeRequirement: intent.runtimePreference === 'mock_ok'
          ? 'Mock provider can validate the happy path; connected runtime preferred for real execution.'
          : 'Connected MCP runtime with model-run/tool-run support is required for real execution.',
      }
    })

    res.json({ generatedAt: new Date().toISOString(), capabilityId: capabilityId ?? null, items })
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
  TOOL_REQUEST: 'serviceTask', GIT_PUSH: 'serviceTask', POLICY_CHECK: 'serviceTask', EVAL_GATE: 'serviceTask', DATA_SINK: 'serviceTask',
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
