import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { EdgeType, ExecutionLocation, NodeType, Prisma, WorkItemRoutingMode, WorkItemTriggerType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { createAgentProfile, AgentAndToolsError, listAgentTemplates, listRuntimeCapabilities, type AgentTemplate } from '../../lib/agent-and-tools/client'
import { logEvent, publishOutbox } from '../../lib/audit'
import { resolveDefaultTeamId } from '../../lib/permissions/workflowTemplate'
import { ValidationError } from '../../lib/errors'
import { normalizeMetadataKey, recordOf, resolveMetadataSnapshot } from '../metadata/metadata.service'
import { createWorkItem } from '../work-items/work-items.service'
import { routeWorkItem } from '../work-items/work-item-routing.service'
import {
  findAttachableWorkItemForTrigger,
  resolveTriggerCorrelationKey,
  triggerDocumentsFromPayload,
  triggerStringAt,
  type TriggerDocument,
} from '../work-items/work-item-trigger-attach'

export const eventVerifierDemoRouter: Router = Router()

const DEMO_KEY = 'event-verifier-demo'
const DEFAULT_AGENT_NAME = 'Verifier'
const DEFAULT_SKILL_FILE = 'verifier-skill.md'
const DEFAULT_EVENT_TYPE = 'VERIFIER_DOCUMENT_SUBMITTED'
const DEFAULT_WORK_ITEM_TYPE = 'DOCUMENT_REVIEW'
const DEFAULT_WORKFLOW_TYPE = 'VERIFIER_DOCUMENT_REVIEW'

const verifierSkillFileContent = `# Verifier Agent Skill

You are the Verifier agent for event-driven document review.

Purpose:
- Read the event payload and every attached document/link.
- Validate the documents against the expected design, policy, and acceptance criteria.
- Return only the structured fields requested by the workflow node.

Rules:
- Treat this skill file and all bound source documents as read-only.
- Do not mutate prompts, skills, policy, or workflow configuration.
- If evidence is missing, set verdict to SEND_BACK and explain exactly what is missing.
- If the document contradicts the stated design or standards, set verdict to REJECT.
- If the evidence is sufficient and internally consistent, set verdict to APPROVE.

Review rubric:
1. Scope coverage: the document addresses the requested capability/work item.
2. Traceability: claims connect to evidence in the document or event payload.
3. Standards: required controls, tests, and acceptance criteria are present.
4. Risk: gaps are clear enough for a human approver to act on.
`

const setupSchema = z.object({
  capabilityId: z.string().uuid().optional(),
  agentName: z.string().min(2).max(120).default(DEFAULT_AGENT_NAME),
  skillFileName: z.string().min(3).max(200).default(DEFAULT_SKILL_FILE),
  skillFileContent: z.string().min(20).max(50_000).default(verifierSkillFileContent),
  eventTypeKey: z.string().min(2).max(120).default(DEFAULT_EVENT_TYPE),
  workItemTypeKey: z.string().min(2).max(120).default(DEFAULT_WORK_ITEM_TYPE),
  workflowTypeKey: z.string().min(2).max(120).default(DEFAULT_WORKFLOW_TYPE),
  workflowName: z.string().min(2).max(200).optional(),
  llmConnectionAlias: z.string().min(1).max(120).default('mock'),
  reviewRequired: z.boolean().default(true),
  emitTransport: z.enum(['EVENTBUS', 'SQS']).default('EVENTBUS'),
  sqsQueueUrl: z.string().url().optional(),
})

const simulateSchema = z.object({
  capabilityId: z.string().uuid().optional(),
  eventTypeKey: z.string().min(2).max(120).default(DEFAULT_EVENT_TYPE),
  payload: z.record(z.unknown()).optional(),
})

const ingestSchema = z.object({
  workId: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  capabilityName: z.string().min(1).max(240),
  eventTypeKey: z.string().min(2).max(120).default(DEFAULT_EVENT_TYPE),
  title: z.string().min(1).max(300).optional(),
  documents: z.array(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
})

function authHeader(req: { headers: { authorization?: unknown } }): string | undefined {
  const value = req.headers.authorization
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function absoluteUrl(req: { protocol: string; get(name: string): string | undefined }, path: string): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}${path}`
}

async function resolveCapabilityId(explicit: string | undefined, authorization: string | undefined): Promise<string> {
  if (explicit) return explicit
  const capabilities = await listRuntimeCapabilities(authorization)
  const selected = capabilities.find(capability => {
    const status = String(capability.status ?? 'ACTIVE').toUpperCase()
    return capability.id && status !== 'ARCHIVED' && status !== 'DEPRECATED'
  })
  if (!selected?.id) {
    throw new ValidationError('No active capability was visible. Pass capabilityId to /api/demo/event-verifier/setup.')
  }
  return selected.id
}

async function resolveCapabilityIdByName(capabilityName: string, authorization: string | undefined): Promise<string> {
  const target = capabilityName.trim().toLowerCase()
  const compactTarget = target.replace(/[\s_-]+/g, '')
  const capabilities = await listRuntimeCapabilities(authorization)
  const active = capabilities.filter(capability => {
    const status = String(capability.status ?? 'ACTIVE').toUpperCase()
    return capability.id && status !== 'ARCHIVED' && status !== 'DEPRECATED'
  })
  const match = active.find(capability => {
    const candidates = [
      capability.id,
      capability.name,
      capability.capability_id,
      capability.capabilityId,
      capability.slug,
      capability.key,
      capability.capabilityKey,
    ].map(value => typeof value === 'string' ? value.trim().toLowerCase() : '')
    return candidates.some(value =>
      value === target || value.replace(/[\s_-]+/g, '') === compactTarget
    )
  })
  if (!match?.id) {
    const visible = active.map(capability => capability.name || capability.id).filter(Boolean).slice(0, 12).join(', ')
    throw new ValidationError(`Capability "${capabilityName}" is not visible or not ACTIVE. Visible capabilities: ${visible || 'none'}.`)
  }
  return match.id
}

function unwrapTemplate(result: { template?: AgentTemplate; profile?: AgentTemplate }): AgentTemplate {
  const template = result.template ?? result.profile
  if (!template?.id) throw new ValidationError('Agent Runtime did not return a Verifier agent template id.')
  return template
}

async function ensureVerifierAgent(args: {
  capabilityId: string
  agentName: string
  skillFileName: string
  skillFileContent: string
  authorization?: string
}): Promise<{ template: AgentTemplate; created: boolean; effectivePermissions?: Array<Record<string, unknown>>; sourceArtifacts?: unknown[] }> {
  const existing = (await listAgentTemplates(args.authorization, {
    scope: 'all',
    capabilityId: args.capabilityId,
    limit: 100,
  })).find(template =>
    String(template.name ?? '').trim().toLowerCase() === args.agentName.trim().toLowerCase()
    && String(template.capabilityId ?? '') === args.capabilityId
  )
  if (existing?.id) return { template: existing, created: false }

  try {
    const created = await createAgentProfile({
      capabilityId: args.capabilityId,
      name: args.agentName,
      roleType: 'GOVERNANCE',
      description: 'Event-driven verifier agent created by the WorkGraph demo setup API.',
      instructions: [
        'Use the read-only Verifier skill file as your governing prompt.',
        'Validate event documents and return the structured output contract exactly.',
        'Do not alter the skill, source prompt, policy, or workflow configuration.',
      ].join('\n'),
      skillBindings: [{
        sourceType: 'uploaded_document',
        name: args.skillFileName,
        description: 'Read-only verifier skill file used as the agent source prompt.',
        skillType: 'DOCUMENT_SOURCE',
        sourceRef: args.skillFileName,
        permissions: ['read'],
        readOnly: true,
        providerLocked: true,
        isDefault: true,
        metadata: {
          demoKey: DEMO_KEY,
          promptRole: 'verifier_skill_file',
          immutablePrompt: true,
        },
      }],
    }, [{
      filename: args.skillFileName,
      content: args.skillFileContent,
      contentType: 'text/markdown',
    }], args.authorization)
    return {
      template: unwrapTemplate(created),
      created: true,
      effectivePermissions: created.effectivePermissions,
      sourceArtifacts: created.sourceArtifacts,
    }
  } catch (err) {
    if (err instanceof AgentAndToolsError && err.status === 409) {
      const templates = await listAgentTemplates(args.authorization, {
        scope: 'all',
        capabilityId: args.capabilityId,
        limit: 100,
      })
      const template = templates.find(row =>
        String(row.name ?? '').trim().toLowerCase() === args.agentName.trim().toLowerCase()
        && String(row.capabilityId ?? '') === args.capabilityId
      )
      if (template?.id) return { template, created: false }
    }
    throw err
  }
}

function verifierDirectLlmConfig(args: {
  capabilityId: string
  agentTemplateId: string
  llmConnectionAlias: string
  reviewRequired: boolean
}): Prisma.InputJsonValue {
  return {
    connectionAlias: args.llmConnectionAlias,
    capabilityId: args.capabilityId,
    agentTemplateId: args.agentTemplateId,
    composeWithPromptComposer: true,
    loopEnabled: true,
    loopStageKey: 'verifier.document_review',
    loopPhases: ['PLAN', 'VERIFY', 'SELF_REVIEW'],
    maxTurns: 3,
    validationMode: 'hard',
    reviewRequired: args.reviewRequired,
    coWork: args.reviewRequired,
    inputDocumentsPath: '_workItem.input.documents',
    outputPath: 'Verifier Review Output',
    inputVariables: {
      workId: '_workItem.input.workId',
      description: '_workItem.input.description',
      capabilityName: '_workItem.input.capabilityName',
      documents: '_workItem.input.documents',
      originalEvent: '_workItem.input.payload',
    },
    task: [
      'Validate the incoming event documents as the Verifier agent.',
      'Use the agent profile skill file as immutable guidance.',
      'Read event payload from workflow context _workItem.input.payload.',
      'Return only JSON matching the configured outputFields.',
    ].join('\n'),
    outputFields: {
      verdict: {
        type: 'string',
        enum: ['APPROVE', 'REJECT', 'SEND_BACK'],
        description: 'Final verifier decision for downstream routing and human approval.',
        required: true,
      },
      confidence: {
        type: 'number',
        description: '0 to 1 confidence score for the verdict.',
        required: true,
      },
      summary: {
        type: 'string',
        description: 'Short plain-language summary for the human approver.',
        required: true,
      },
      findings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete evidence-backed findings or gaps.',
        required: true,
      },
      requiredFixes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fixes required when verdict is REJECT or SEND_BACK.',
        required: false,
      },
    },
  } as Prisma.InputJsonValue
}

function eventEmitConfig(args: {
  transport: 'EVENTBUS' | 'SQS'
  queueUrl?: string
  eventName?: string
  payloadPath?: string
  failOnError?: boolean
}): Prisma.InputJsonValue {
  return {
    transport: args.transport,
    eventName: args.eventName ?? 'verifier.review.completed',
    ...(args.payloadPath ? { payloadPath: args.payloadPath } : {}),
    keyPath: '_workItem.input.workId',
    failOnError: args.failOnError ?? args.transport === 'EVENTBUS',
    ...(args.transport === 'SQS' ? { queueUrl: args.queueUrl } : {}),
  } as Prisma.InputJsonValue
}

async function upsertVerifierWorkflow(args: {
  actorId: string
  capabilityId: string
  workflowName: string
  workflowTypeKey: string
  workItemTypeKey: string
  agentTemplateId: string
  llmConnectionAlias: string
  reviewRequired: boolean
  emitTransport: 'EVENTBUS' | 'SQS'
  sqsQueueUrl?: string
}) {
  if (args.emitTransport === 'SQS' && !args.sqsQueueUrl) {
    throw new ValidationError('SQS event emit selected, but sqsQueueUrl was not provided.')
  }
  const teamId = await resolveDefaultTeamId(args.actorId)
  const workflowTypeMeta = await resolveMetadataSnapshot({
    kind: 'WORKFLOW_TYPE',
    key: args.workflowTypeKey,
    capabilityId: args.capabilityId,
  })
  const nodeTypes = [NodeType.START, NodeType.DIRECT_LLM_TASK, NodeType.EVENT_EMIT, NodeType.END]
  const nodeMeta = new Map<NodeType, Awaited<ReturnType<typeof resolveMetadataSnapshot>>>()
  for (const nodeType of nodeTypes) {
    nodeMeta.set(nodeType, await resolveMetadataSnapshot({
      kind: 'NODE_TYPE',
      key: normalizeMetadataKey(nodeType),
      capabilityId: args.capabilityId,
    }))
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workflow.findFirst({
      where: {
        capabilityId: args.capabilityId,
        archivedAt: null,
        metadata: { path: ['demoKey'], equals: DEMO_KEY },
      },
      orderBy: { updatedAt: 'desc' },
    })
    const workflow = existing
      ? await tx.workflow.update({
        where: { id: existing.id },
        data: {
          name: args.workflowName,
          description: 'Event-based verifier workflow generated by the demo setup API.',
          status: 'ACTIVE',
          workflowTypeKey: args.workflowTypeKey,
          typeVersion: workflowTypeMeta.version,
          typeSnapshot: workflowTypeMeta.snapshot as any ?? undefined,
          eligibleWorkItemTypes: [args.workItemTypeKey] as unknown as Prisma.InputJsonValue,
          isDefaultForType: true,
          defaultRoutingMode: WorkItemRoutingMode.AUTO_START,
          metadata: {
            demoKey: DEMO_KEY,
            agentTemplateId: args.agentTemplateId,
            llmConnectionAlias: args.llmConnectionAlias,
            emitTransport: args.emitTransport,
            updatedByDemoAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      : await tx.workflow.create({
        data: {
          name: args.workflowName,
          description: 'Event-based verifier workflow generated by the demo setup API.',
          status: 'ACTIVE',
          teamId,
          createdById: args.actorId,
          capabilityId: args.capabilityId,
          workflowTypeKey: args.workflowTypeKey,
          typeVersion: workflowTypeMeta.version,
          typeSnapshot: workflowTypeMeta.snapshot as any ?? undefined,
          profile: 'main',
          eligibleWorkItemTypes: [args.workItemTypeKey] as unknown as Prisma.InputJsonValue,
          isDefaultForType: true,
          defaultRoutingMode: WorkItemRoutingMode.AUTO_START,
          variables: [] as unknown as Prisma.InputJsonValue,
          metadata: {
            demoKey: DEMO_KEY,
            agentTemplateId: args.agentTemplateId,
            llmConnectionAlias: args.llmConnectionAlias,
            emitTransport: args.emitTransport,
            createdByDemoAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })

    await tx.workflowDesignEdge.deleteMany({ where: { workflowId: workflow.id } })
    await tx.workflowDesignNode.deleteMany({ where: { workflowId: workflow.id } })

    const startId = randomUUID()
    const receivedEmitId = randomUUID()
    const verifierId = randomUUID()
    const completedEmitId = randomUUID()
    const endId = randomUUID()

    const nodeRows = [
      {
        id: startId,
        workflowId: workflow.id,
        nodeType: NodeType.START,
        nodeTypeKey: normalizeMetadataKey(NodeType.START),
        nodeTypeVersion: nodeMeta.get(NodeType.START)?.version ?? 1,
        nodeTypeSnapshot: nodeMeta.get(NodeType.START)?.snapshot as any ?? undefined,
        label: 'Event received',
        config: {} as Prisma.InputJsonValue,
        executionLocation: ExecutionLocation.SERVER,
        positionX: 80,
        positionY: 220,
      },
      {
        id: receivedEmitId,
        workflowId: workflow.id,
        nodeType: NodeType.EVENT_EMIT,
        nodeTypeKey: normalizeMetadataKey(NodeType.EVENT_EMIT),
        nodeTypeVersion: nodeMeta.get(NodeType.EVENT_EMIT)?.version ?? 1,
        nodeTypeSnapshot: nodeMeta.get(NodeType.EVENT_EMIT)?.snapshot as any ?? undefined,
        label: 'Emit work received',
        config: eventEmitConfig({
          transport: args.emitTransport,
          queueUrl: args.sqsQueueUrl,
          eventName: 'verifier.review.received',
          payloadPath: '_workItem.input',
        }),
        executionLocation: ExecutionLocation.SERVER,
        positionX: 320,
        positionY: 220,
      },
      {
        id: verifierId,
        workflowId: workflow.id,
        nodeType: NodeType.DIRECT_LLM_TASK,
        nodeTypeKey: normalizeMetadataKey(NodeType.DIRECT_LLM_TASK),
        nodeTypeVersion: nodeMeta.get(NodeType.DIRECT_LLM_TASK)?.version ?? 1,
        nodeTypeSnapshot: nodeMeta.get(NodeType.DIRECT_LLM_TASK)?.snapshot as any ?? undefined,
        label: 'Verifier agent review',
        config: verifierDirectLlmConfig({
          capabilityId: args.capabilityId,
          agentTemplateId: args.agentTemplateId,
          llmConnectionAlias: args.llmConnectionAlias,
          reviewRequired: args.reviewRequired,
        }),
        executionLocation: ExecutionLocation.SERVER,
        positionX: 600,
        positionY: 220,
      },
      {
        id: completedEmitId,
        workflowId: workflow.id,
        nodeType: NodeType.EVENT_EMIT,
        nodeTypeKey: normalizeMetadataKey(NodeType.EVENT_EMIT),
        nodeTypeVersion: nodeMeta.get(NodeType.EVENT_EMIT)?.version ?? 1,
        nodeTypeSnapshot: nodeMeta.get(NodeType.EVENT_EMIT)?.snapshot as any ?? undefined,
        label: 'Emit verifier status',
        config: eventEmitConfig({
          transport: args.emitTransport,
          queueUrl: args.sqsQueueUrl,
          eventName: 'verifier.review.completed',
        }),
        executionLocation: ExecutionLocation.SERVER,
        positionX: 900,
        positionY: 220,
      },
      {
        id: endId,
        workflowId: workflow.id,
        nodeType: NodeType.END,
        nodeTypeKey: normalizeMetadataKey(NodeType.END),
        nodeTypeVersion: nodeMeta.get(NodeType.END)?.version ?? 1,
        nodeTypeSnapshot: nodeMeta.get(NodeType.END)?.snapshot as any ?? undefined,
        label: 'Verifier complete',
        config: {} as Prisma.InputJsonValue,
        executionLocation: ExecutionLocation.SERVER,
        positionX: 1180,
        positionY: 220,
      },
    ]
    await tx.workflowDesignNode.createMany({ data: nodeRows })
    await tx.workflowDesignEdge.createMany({
      data: [
        { workflowId: workflow.id, sourceNodeId: startId, targetNodeId: receivedEmitId, edgeType: EdgeType.SEQUENTIAL },
        { workflowId: workflow.id, sourceNodeId: receivedEmitId, targetNodeId: verifierId, edgeType: EdgeType.SEQUENTIAL },
        { workflowId: workflow.id, sourceNodeId: verifierId, targetNodeId: completedEmitId, edgeType: EdgeType.SEQUENTIAL },
        { workflowId: workflow.id, sourceNodeId: completedEmitId, targetNodeId: endId, edgeType: EdgeType.SEQUENTIAL },
      ],
    })

    const policy = await tx.workItemRoutingPolicy.findFirst({
      where: {
        capabilityId: args.capabilityId,
        workItemTypeKey: args.workItemTypeKey,
        workflowTypeKey: args.workflowTypeKey,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    })
    const routingPolicy = policy
      ? await tx.workItemRoutingPolicy.update({
        where: { id: policy.id },
        data: {
          workflowId: workflow.id,
          routingMode: WorkItemRoutingMode.AUTO_START,
          priority: 900,
          selector: { demoKey: DEMO_KEY } as Prisma.InputJsonValue,
        },
      })
      : await tx.workItemRoutingPolicy.create({
        data: {
          capabilityId: args.capabilityId,
          workItemTypeKey: args.workItemTypeKey,
          workflowTypeKey: args.workflowTypeKey,
          workflowId: workflow.id,
          routingMode: WorkItemRoutingMode.AUTO_START,
          priority: 900,
          selector: { demoKey: DEMO_KEY } as Prisma.InputJsonValue,
          isActive: true,
        },
      })

    return { workflow, routingPolicy, nodeIds: { startId, receivedEmitId, verifierId, completedEmitId, endId } }
  })
}

async function upsertEventTrigger(args: {
  capabilityId: string
  eventTypeKey: string
  workItemTypeKey: string
}) {
  const mapping = {
    titlePath: '$.title',
    descriptionPath: '$.description',
    documentsPath: '$.documents',
    workItemIdPath: '$.workItemId',
    workCodePath: '$.workCode',
    correlationKeyPath: '$.externalId',
    workIdPath: '$.workId',
    capabilityNamePath: '$.capabilityName',
    filter: { demoKey: DEMO_KEY },
  }
  const existing = await prisma.workItemTrigger.findFirst({
    where: {
      triggerType: WorkItemTriggerType.EVENT,
      eventTypeKey: args.eventTypeKey,
      capabilityId: args.capabilityId,
      workItemTypeKey: args.workItemTypeKey,
      isActive: true,
    },
    orderBy: { updatedAt: 'desc' },
  })
  if (existing) {
    return prisma.workItemTrigger.update({
      where: { id: existing.id },
      data: {
        routingMode: WorkItemRoutingMode.AUTO_START,
        payloadMapping: mapping as Prisma.InputJsonValue,
        scheduleConfig: { demoKey: DEMO_KEY } as Prisma.InputJsonValue,
      },
    })
  }
  return prisma.workItemTrigger.create({
    data: {
      triggerType: WorkItemTriggerType.EVENT,
      eventTypeKey: args.eventTypeKey,
      capabilityId: args.capabilityId,
      workItemTypeKey: args.workItemTypeKey,
      routingMode: WorkItemRoutingMode.AUTO_START,
      payloadMapping: mapping as Prisma.InputJsonValue,
      scheduleConfig: { demoKey: DEMO_KEY } as Prisma.InputJsonValue,
      isActive: true,
    },
  })
}

function sampleEventPayload() {
  const workId = `WRK-${Date.now()}`
  return {
    demoKey: DEMO_KEY,
    workId,
    externalId: workId,
    workCode: workId,
    capabilityName: 'Delivery',
    title: `${workId} · Validate checkout design document`,
    description: 'Event-driven verifier review for an incoming design artifact.',
    documents: [{
      label: 'Checkout design document',
      mediaType: 'text/markdown',
      content: [
        '# Checkout Design',
        'Goal: add guarded checkout payment retry.',
        'Acceptance criteria: retries are capped, audit receipt is emitted, tests cover declined cards.',
        'Risk: missing rollback section.',
      ].join('\n\n'),
    }],
  }
}

function runUrl(runId: string | undefined): string | undefined {
  return runId ? `/runs/${runId}` : undefined
}

function normalizedWorkEventPayload(body: z.infer<typeof ingestSchema>): Record<string, unknown> {
  return {
    ...(body.payload ?? {}),
    demoKey: DEMO_KEY,
    workId: body.workId,
    externalId: body.workId,
    workCode: body.workId,
    title: body.title ?? `${body.workId} · ${body.description.slice(0, 80)}`,
    description: body.description,
    capabilityName: body.capabilityName,
    documents: body.documents ?? (Array.isArray(body.payload?.documents) ? body.payload.documents : []),
  }
}

async function createOrAttachWorkItemFromTrigger(args: {
  trigger: {
    id: string
    capabilityId: string | null
    eventTypeKey: string | null
    workItemTypeKey: string
    routingMode: WorkItemRoutingMode
    payloadMapping: unknown
    dedupeKey?: string | null
  }
  payload: Record<string, unknown>
  workflowTypeKey?: string
}) {
  if (!args.trigger.capabilityId) throw new ValidationError('Event trigger does not have a capabilityId.')
  const mapping = recordOf(args.trigger.payloadMapping)
  const now = new Date()
  const title = triggerStringAt(args.payload, mapping.titlePath) ?? `${args.trigger.workItemTypeKey} event work`
  const description = triggerStringAt(args.payload, mapping.descriptionPath)
    ?? (typeof mapping.description === 'string' ? mapping.description : undefined)
  const documents = triggerDocumentsFromPayload({ payload: args.payload, payloadMapping: mapping })
  const correlationKey = resolveTriggerCorrelationKey({
    payload: args.payload,
    payloadMapping: mapping,
    dedupeKey: args.trigger.dedupeKey,
  })
  const attachable = await findAttachableWorkItemForTrigger({
    payload: args.payload,
    payloadMapping: mapping,
    dedupeKey: args.trigger.dedupeKey,
    capabilityId: args.trigger.capabilityId,
  })

  const workItem = attachable?.workItem ?? await createWorkItem({
    title,
    description,
    workItemTypeKey: args.trigger.workItemTypeKey,
    routingMode: args.trigger.routingMode,
    workflowTypeKey: args.workflowTypeKey,
    sourceEventTypeKey: args.trigger.eventTypeKey ?? undefined,
    parentCapabilityId: args.trigger.capabilityId,
    input: {
      triggerType: 'EVENT',
      eventType: args.trigger.eventTypeKey,
      payload: args.payload,
      workId: triggerStringAt(args.payload, '$.workId') ?? correlationKey ?? undefined,
      externalId: triggerStringAt(args.payload, '$.externalId') ?? correlationKey ?? undefined,
      description,
      capabilityName: triggerStringAt(args.payload, '$.capabilityName'),
      triggerCorrelationKey: correlationKey,
      documents,
    },
    details: {
      title,
      description: description ?? null,
      source: 'event-verifier-demo',
      triggerId: args.trigger.id,
      triggerCorrelationKey: correlationKey ?? null,
      workId: triggerStringAt(args.payload, '$.workId') ?? correlationKey ?? null,
      externalId: triggerStringAt(args.payload, '$.externalId') ?? correlationKey ?? null,
      capabilityName: triggerStringAt(args.payload, '$.capabilityName') ?? null,
      documents,
      firedAt: now.toISOString(),
      input: args.payload,
      workflowTypeKey: args.workflowTypeKey,
    },
    originType: 'CAPABILITY_LOCAL',
    targets: [{ targetCapabilityId: args.trigger.capabilityId }],
  }, null)

  if (attachable) {
    const existingInput = recordOf(attachable.workItem.input)
    const existingDetails = recordOf(attachable.workItem.details)
    const priorDocuments = Array.isArray(existingInput.documents) ? existingInput.documents as TriggerDocument[] : []
    await prisma.workItem.update({
      where: { id: attachable.workItem.id },
      data: {
        input: {
          ...existingInput,
          latestTriggerEvent: args.payload,
          triggerCorrelationKey: correlationKey,
          workId: existingInput.workId ?? triggerStringAt(args.payload, '$.workId') ?? correlationKey,
          externalId: existingInput.externalId ?? triggerStringAt(args.payload, '$.externalId') ?? correlationKey,
          capabilityName: existingInput.capabilityName ?? triggerStringAt(args.payload, '$.capabilityName'),
          documents: [...priorDocuments, ...documents].slice(0, 24),
        } as Prisma.InputJsonValue,
        details: {
          ...existingDetails,
          latestTriggerEvent: args.payload,
          latestTriggerAt: now.toISOString(),
          latestTriggerMatchedBy: attachable.matchedBy,
          workId: existingDetails.workId ?? triggerStringAt(args.payload, '$.workId') ?? correlationKey,
          externalId: existingDetails.externalId ?? triggerStringAt(args.payload, '$.externalId') ?? correlationKey,
          capabilityName: existingDetails.capabilityName ?? triggerStringAt(args.payload, '$.capabilityName'),
          documents: [...(Array.isArray(existingDetails.documents) ? existingDetails.documents as TriggerDocument[] : []), ...documents].slice(0, 24),
        } as Prisma.InputJsonValue,
      },
    })
    await prisma.workItemEvent.create({
      data: {
        workItemId: attachable.workItem.id,
        eventType: 'TRIGGERED',
        payload: {
          triggerId: args.trigger.id,
          firedAt: now.toISOString(),
          attachedExisting: true,
          matchedBy: attachable.matchedBy,
          triggerCorrelationKey: correlationKey,
          documents,
        } as Prisma.InputJsonValue,
      },
    })
  }

  await prisma.workItemTrigger.update({
    where: { id: args.trigger.id },
    data: { lastFiredAt: now },
  })

  const routed = await routeWorkItem(workItem.id, null, {
    routingMode: args.trigger.routingMode,
    workflowTypeKey: args.workflowTypeKey,
  })
  return {
    workItem: routed,
    attachedExisting: Boolean(attachable),
    matchedBy: attachable?.matchedBy,
    documents,
  }
}

eventVerifierDemoRouter.get('/skill-file', (_req, res) => {
  res.type('text/markdown').send(verifierSkillFileContent)
})

eventVerifierDemoRouter.post('/setup', async (req, res, next) => {
  try {
    const body = setupSchema.parse(req.body ?? {})
    const authorization = authHeader(req)
    const capabilityId = await resolveCapabilityId(body.capabilityId, authorization)
    const eventTypeKey = normalizeMetadataKey(body.eventTypeKey)
    const workItemTypeKey = normalizeMetadataKey(body.workItemTypeKey)
    const workflowTypeKey = normalizeMetadataKey(body.workflowTypeKey)
    const workflowName = body.workflowName ?? `Event Verifier · ${workItemTypeKey}`
    const agent = await ensureVerifierAgent({
      capabilityId,
      agentName: body.agentName,
      skillFileName: body.skillFileName,
      skillFileContent: body.skillFileContent,
      authorization,
    })
    const workflow = await upsertVerifierWorkflow({
      actorId: req.user!.userId,
      capabilityId,
      workflowName,
      workflowTypeKey,
      workItemTypeKey,
      agentTemplateId: agent.template.id,
      llmConnectionAlias: body.llmConnectionAlias,
      reviewRequired: body.reviewRequired,
      emitTransport: body.emitTransport,
      sqsQueueUrl: body.sqsQueueUrl,
    })
    const trigger = await upsertEventTrigger({ capabilityId, eventTypeKey, workItemTypeKey })

    await logEvent('EventVerifierDemoConfigured', 'Workflow', workflow.workflow.id, req.user!.userId, {
      capabilityId,
      agentTemplateId: agent.template.id,
      triggerId: trigger.id,
      workflowTypeKey,
      workItemTypeKey,
      eventTypeKey,
    })
    await publishOutbox('Workflow', workflow.workflow.id, 'EventVerifierDemoConfigured', {
      capabilityId,
      workflowId: workflow.workflow.id,
      agentTemplateId: agent.template.id,
      eventTypeKey,
    })

    const samplePayload = sampleEventPayload()
    res.status(201).json({
      data: {
        demoKey: DEMO_KEY,
        capabilityId,
        skillFile: {
          filename: body.skillFileName,
          endpoint: '/api/demo/event-verifier/skill-file',
          url: absoluteUrl(req, '/api/demo/event-verifier/skill-file'),
          readOnly: true,
          providerLocked: true,
        },
        agent: {
          id: agent.template.id,
          name: agent.template.name,
          created: agent.created,
          sourceArtifacts: agent.sourceArtifacts ?? [],
          effectivePermissions: agent.effectivePermissions ?? [],
        },
        workflow: {
          id: workflow.workflow.id,
          name: workflow.workflow.name,
          workflowTypeKey,
          designerUrl: `/workflows/design/${workflow.workflow.id}`,
          nodes: workflow.nodeIds,
        },
        routingPolicy: workflow.routingPolicy,
        eventTrigger: trigger,
        simulate: {
          endpoint: '/api/demo/event-verifier/simulate',
          samplePayload,
          curl: [
            'curl -s -X POST http://localhost:8080/api/demo/event-verifier/simulate \\',
            '  -H "Authorization: Bearer $WORKGRAPH_TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            `  -d '${JSON.stringify({ capabilityId, eventTypeKey, payload: samplePayload })}' | jq`,
          ].join('\n'),
        },
        ingest: {
          endpoint: '/api/demo/event-verifier/ingest',
          contract: {
            workId: 'external stable work identifier',
            description: 'work description/story/problem statement',
            capabilityName: 'visible capability name, slug, key, or id',
            documents: 'optional array of links or inline document objects',
          },
          callbacks: [
            'verifier.review.received',
            'direct.llm.run.started',
            'direct.llm.review.requested',
            'direct.llm.review.approved',
            'direct.llm.review.rejected',
            'verifier.review.completed',
          ],
          curl: [
            'curl -s -X POST http://localhost:8080/api/demo/event-verifier/ingest \\',
            '  -H "Authorization: Bearer $WORKGRAPH_TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            `  -d '${JSON.stringify({ workId: 'WRK-EXT-1001', description: 'Validate the uploaded design against standards and acceptance criteria.', capabilityName: 'Delivery', documents: samplePayload.documents })}' | jq`,
          ].join('\n'),
        },
        localStackHint: {
          current: 'Use /simulate to drive the event trigger without extra infrastructure.',
          next: 'For SQS inbound, add a small poller that reads LocalStack SQS messages and POSTs the body to /api/demo/event-verifier/simulate.',
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

eventVerifierDemoRouter.post('/ingest', async (req, res, next) => {
  try {
    const body = ingestSchema.parse(req.body ?? {})
    const authorization = authHeader(req)
    const capabilityId = await resolveCapabilityIdByName(body.capabilityName, authorization)
    const eventTypeKey = normalizeMetadataKey(body.eventTypeKey)
    const payload = normalizedWorkEventPayload(body)
    const trigger = await prisma.workItemTrigger.findFirst({
      where: {
        triggerType: WorkItemTriggerType.EVENT,
        eventTypeKey,
        capabilityId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    })
    if (!trigger) {
      throw new ValidationError(`No active WorkItem event trigger found for capability "${body.capabilityName}" and event ${eventTypeKey}. Run POST /api/demo/event-verifier/setup for that capability first.`)
    }

    await publishOutbox('ExternalEvent', body.workId, 'EventVerifierWorkReceived', {
      workId: body.workId,
      capabilityId,
      capabilityName: body.capabilityName,
      eventTypeKey,
      payload,
      actorId: req.user!.userId,
    })

    const workflowTypeKey = normalizeMetadataKey(recordOf(trigger.payloadMapping).workflowTypeKey ?? DEFAULT_WORKFLOW_TYPE)
    const result = await createOrAttachWorkItemFromTrigger({
      trigger,
      payload,
      workflowTypeKey,
    })
    const runId = result.workItem.targets.find(target => target.childWorkflowInstanceId)?.childWorkflowInstanceId
    res.status(201).json({
      data: {
        eventTypeKey,
        capabilityId,
        capabilityName: body.capabilityName,
        workId: body.workId,
        triggerId: trigger.id,
        attachedExisting: result.attachedExisting,
        matchedBy: result.matchedBy,
        documents: result.documents,
        workItem: result.workItem,
        workflowInstanceId: runId,
        runUrl: runUrl(runId ?? undefined),
        callbackEvents: [
          'event.verifier.work.received',
          'verifier.review.received',
          'direct.llm.run.started',
          'direct.llm.review.requested',
          'direct.llm.review.approved',
          'direct.llm.review.rejected',
          'verifier.review.completed',
          'workflow.completed',
          'workflow.failed',
        ],
      },
    })
  } catch (err) {
    next(err)
  }
})

eventVerifierDemoRouter.post('/simulate', async (req, res, next) => {
  try {
    const body = simulateSchema.parse(req.body ?? {})
    const authorization = authHeader(req)
    const capabilityId = await resolveCapabilityId(body.capabilityId, authorization)
    const eventTypeKey = normalizeMetadataKey(body.eventTypeKey)
    const payload = {
      ...sampleEventPayload(),
      ...(body.payload ?? {}),
      demoKey: DEMO_KEY,
    }
    const trigger = await prisma.workItemTrigger.findFirst({
      where: {
        triggerType: WorkItemTriggerType.EVENT,
        eventTypeKey,
        capabilityId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    })
    if (!trigger) {
      throw new ValidationError(`No active WorkItem event trigger found for ${eventTypeKey}. Run POST /api/demo/event-verifier/setup first.`)
    }

    await publishOutbox('ExternalEvent', String(payload.externalId ?? randomUUID()), 'EventVerifierDemoReceived', {
      capabilityId,
      eventTypeKey,
      payload,
      actorId: req.user!.userId,
    })

    const workflowTypeKey = normalizeMetadataKey(recordOf(trigger.payloadMapping).workflowTypeKey ?? DEFAULT_WORKFLOW_TYPE)
    const result = await createOrAttachWorkItemFromTrigger({
      trigger,
      payload,
      workflowTypeKey,
    })
    const runId = result.workItem.targets.find(target => target.childWorkflowInstanceId)?.childWorkflowInstanceId
    res.status(201).json({
      data: {
        eventTypeKey,
        capabilityId,
        triggerId: trigger.id,
        attachedExisting: result.attachedExisting,
        matchedBy: result.matchedBy,
        documents: result.documents,
        workItem: result.workItem,
        workflowInstanceId: runId,
        runUrl: runUrl(runId ?? undefined),
      },
    })
  } catch (err) {
    next(err)
  }
})
