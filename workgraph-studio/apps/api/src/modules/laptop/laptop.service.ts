import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { config } from '../../config'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { promptComposerClient } from '../../lib/prompt-composer/client'
import { assertCanViewWorkItem } from '../work-items/work-items.service'

type JsonRecord = Record<string, unknown>

export type StartLaptopInvocationInput = {
  client?: string
  mode?: 'direct-copilot' | 'server-runtime'
  capabilityId?: string
  agentTemplateId?: string
  repoUrl?: string
  branch?: string
  baseCommitSha?: string
  task?: string
  agentSpec?: JsonRecord
  data?: JsonRecord
}

export type CreateQuestionInput = {
  question: string
  context?: JsonRecord
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function workItemTask(workItem: { title: string; description: string | null; input: Prisma.JsonValue }): string {
  const details = asRecord(workItem.input)
  const inputText = Object.keys(details).length > 0 ? `\n\nInput:\n${JSON.stringify(details, null, 2)}` : ''
  return `${workItem.title}\n\n${workItem.description ?? ''}${inputText}`.trim()
}

function mcpBaseUrl(): string {
  return config.MCP_SERVER_URL.replace(/\/+$/, '')
}

async function mintMcpSessionToken(input: {
  invocationId: string
  agentRunId: string
  capabilityId?: string | null
  client: string
  userId: string
}) {
  const res = await fetch(`${mcpBaseUrl()}/mcp/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
    },
    body: JSON.stringify({
      invocationId: input.invocationId,
      agentRunId: input.agentRunId,
      capabilityId: input.capabilityId ?? undefined,
      origin: 'laptop',
      client: input.client,
      subject: input.userId,
      ttlSeconds: config.LAPTOP_MCP_TOKEN_TTL_SEC,
      scopes: ['tools:list', 'tools:call', 'resources:read', 'events:read', 'invoke'],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ValidationError(`MCP session token mint failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return await res.json() as { token: string; jti: string; expiresAt: string; scopes: string[] }
}

async function ensureLaptopAgent(actorId: string, externalTemplateId?: string | null) {
  if (externalTemplateId) {
    const existing = await prisma.agent.findFirst({ where: { externalTemplateId } })
    if (existing) return existing
    return prisma.agent.create({
      data: {
        name: 'Laptop Copilot Runtime',
        description: 'Direct Copilot laptop session agent snapshot',
        provider: 'COPILOT',
        model: 'copilot-cli',
        externalTemplateId,
        fetchedBy: actorId,
      },
    })
  }
  const existing = await prisma.agent.findFirst({
    where: { provider: 'COPILOT', model: 'copilot-cli', externalTemplateId: null },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) return existing
  return prisma.agent.create({
    data: {
      name: 'Laptop Copilot Runtime',
      description: 'Direct Copilot laptop session agent snapshot',
      provider: 'COPILOT',
      model: 'copilot-cli',
      fetchedBy: actorId,
    },
  })
}

async function composeLaptopPrompt(input: {
  agentTemplateId?: string
  capabilityId?: string | null
  task: string
  workItemId: string
  client: string
  mode: string
}) {
  if (!input.agentTemplateId) {
    return {
      promptAssemblyId: null,
      renderedPrompt: [
        'You are running as a Singularity laptop coding agent.',
        `Execution mode: ${input.mode}`,
        `Client: ${input.client}`,
        '',
        input.task,
      ].join('\n'),
      warnings: ['agentTemplateId not supplied; used local fallback prompt'],
    }
  }
  try {
    const composed = await promptComposerClient.composeAndRespond({
      agentTemplateId: input.agentTemplateId,
      capabilityId: input.capabilityId ?? undefined,
      task: input.task,
      workflowContext: {
        instanceId: `laptop-${input.workItemId}`,
        nodeId: 'direct-copilot',
        phaseId: 'LAPTOP_EXECUTION',
        vars: {
          laptopExecutionMode: input.mode,
          laptopClient: input.client,
          workItemId: input.workItemId,
        },
      },
      overrides: {
        extraContext: [
          'Execution origin: laptop.',
          'Direct Copilot laptop mode is primary. Server runtime remains available for compatibility.',
          'Upload hooks, questions, token usage, heartbeats, and completion events through the Singularity laptop SDK.',
        ].join('\n'),
      },
      previewOnly: true,
    })
    return {
      promptAssemblyId: composed.promptAssemblyId,
      renderedPrompt: [composed.assembled?.systemPrompt, composed.assembled?.message].filter(Boolean).join('\n\n'),
      warnings: composed.warnings ?? [],
    }
  } catch (err) {
    return {
      promptAssemblyId: null,
      renderedPrompt: [
        'You are running as a Singularity laptop coding agent.',
        'Prompt Composer was unavailable, so this fallback prompt contains only the WorkItem request.',
        '',
        input.task,
      ].join('\n'),
      warnings: [`prompt composition failed: ${(err as Error).message}`],
    }
  }
}

export async function startLaptopInvocation(workItemId: string, actorId: string, input: StartLaptopInvocationInput) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: { orderBy: { createdAt: 'asc' } } },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(actorId, workItem)

  const targetCapabilityId = input.capabilityId ?? workItem.targets[0]?.targetCapabilityId ?? workItem.parentCapabilityId ?? null
  const client = input.client?.trim() || 'sgl-cli'
  const mode = input.mode ?? 'direct-copilot'
  const task = input.task?.trim() || workItemTask(workItem)
  const invocationId = randomUUID()
  const agent = await ensureLaptopAgent(actorId, input.agentTemplateId ?? null)
  const prompt = await composeLaptopPrompt({
    agentTemplateId: input.agentTemplateId,
    capabilityId: targetCapabilityId,
    task,
    workItemId,
    client,
    mode,
  })

  const traceId = `laptop-${invocationId}`
  const run = await prisma.agentRun.create({
    data: {
      agentId: agent.id,
      status: 'RUNNING',
      initiatedById: actorId,
      origin: 'laptop',
      client,
      traceId,
      promptAssemblyId: prompt.promptAssemblyId ?? undefined,
      laptopInvocationId: invocationId,
      startedAt: new Date(),
      inputs: {
        create: [{
          inputType: 'LAPTOP_WORKITEM',
          payload: {
            workItemId,
            task,
            mode,
            client,
            capabilityId: targetCapabilityId,
            agentTemplateId: input.agentTemplateId ?? null,
          } as Prisma.InputJsonValue,
        }],
      },
    },
  })

  const token = await mintMcpSessionToken({
    invocationId,
    agentRunId: run.id,
    capabilityId: targetCapabilityId,
    client,
    userId: actorId,
  })

  const invocation = await prisma.laptopInvocation.create({
    data: {
      id: invocationId,
      workItemId,
      agentRunId: run.id,
      capabilityId: targetCapabilityId ?? undefined,
      client,
      mode,
      status: 'STARTED',
      userId: actorId,
      mcpUrl: mcpBaseUrl(),
      mcpTokenJti: token.jti,
      repoUrl: input.repoUrl,
      branch: input.branch,
      baseCommitSha: input.baseCommitSha,
      renderedPrompt: prompt.renderedPrompt,
      promptAssemblyId: prompt.promptAssemblyId ?? undefined,
      envelopeAssemblyId: prompt.promptAssemblyId ?? undefined,
      agentSpec: (input.agentSpec ?? {}) as Prisma.InputJsonValue,
      data: {
        ...(input.data ?? {}),
        warnings: prompt.warnings,
      } as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
    },
    include: { questions: true },
  })

  await prisma.workItemEvent.create({
    data: {
      workItemId,
      eventType: 'STARTED',
      actorId,
      payload: { laptopInvocationId: invocation.id, agentRunId: run.id, mode, client } as Prisma.InputJsonValue,
    },
  })
  await logEvent('LaptopInvocationStarted', 'LaptopInvocation', invocation.id, actorId, {
    workItemId,
    agentRunId: run.id,
    capabilityId: targetCapabilityId ?? undefined,
    mode,
    client,
    traceId,
  })
  await publishOutbox('LaptopInvocation', invocation.id, 'LaptopInvocationStarted', {
    workItemId,
    agentRunId: run.id,
    laptopInvocationId: invocation.id,
    capabilityId: targetCapabilityId ?? undefined,
    actorId,
    mode,
    client,
    traceId,
  })

  return {
    invocation,
    agentRun: run,
    mcp: {
      url: mcpBaseUrl(),
      token: token.token,
      tokenJti: token.jti,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
    },
    prompt: {
      assemblyId: prompt.promptAssemblyId,
      content: prompt.renderedPrompt,
      warnings: prompt.warnings,
    },
  }
}

async function loadInvocationForActor(invocationId: string, actorId: string) {
  const invocation = await prisma.laptopInvocation.findUnique({
    where: { id: invocationId },
    include: { workItem: { include: { targets: true } } },
  })
  if (!invocation) throw new NotFoundError('LaptopInvocation', invocationId)
  await assertCanViewWorkItem(actorId, invocation.workItem)
  return invocation
}

export async function recordLaptopHeartbeat(invocationId: string, actorId: string, payload: JsonRecord = {}) {
  await loadInvocationForActor(invocationId, actorId)
  const invocation = await prisma.laptopInvocation.update({
    where: { id: invocationId },
    data: {
      lastHeartbeatAt: new Date(),
      status: { set: 'RUNNING' },
      data: payload as Prisma.InputJsonValue,
    },
  })
  await publishOutbox('LaptopInvocation', invocationId, 'LaptopSessionHeartbeat', {
    laptopInvocationId: invocationId,
    actorId,
    client: invocation.client,
    traceId: `laptop-${invocationId}`,
  })
  return invocation
}

export async function completeLaptopInvocation(invocationId: string, actorId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED', payload: JsonRecord = {}) {
  const loaded = await loadInvocationForActor(invocationId, actorId)
  const now = new Date()
  const invocation = await prisma.laptopInvocation.update({
    where: { id: invocationId },
    data: {
      status,
      endedAt: now,
      data: { ...asRecord(loaded.data), ...payload } as Prisma.InputJsonValue,
    },
  })
  await prisma.agentRun.update({
    where: { id: loaded.agentRunId },
    data: {
      status: status === 'COMPLETED' ? 'APPROVED' : 'FAILED',
      completedAt: now,
      outputs: {
        create: [{
          outputType: 'LAPTOP_COMPLETION',
          structuredPayload: {
            laptopInvocationId: invocationId,
            status,
            ...payload,
          } as Prisma.InputJsonValue,
        }],
      },
    },
  })
  await logEvent('LaptopInvocationCompleted', 'LaptopInvocation', invocationId, actorId, {
    workItemId: loaded.workItemId,
    agentRunId: loaded.agentRunId,
    status,
  })
  await publishOutbox('LaptopInvocation', invocationId, 'LaptopInvocationCompleted', {
    workItemId: loaded.workItemId,
    agentRunId: loaded.agentRunId,
    laptopInvocationId: invocationId,
    actorId,
    status,
    traceId: `laptop-${invocationId}`,
  })
  return invocation
}

export async function createLaptopQuestion(invocationId: string, actorId: string, input: CreateQuestionInput) {
  const invocation = await loadInvocationForActor(invocationId, actorId)
  if (!input.question.trim()) throw new ValidationError('question is required')
  const question = await prisma.laptopQuestion.create({
    data: {
      invocationId,
      workItemId: invocation.workItemId,
      question: input.question.trim(),
      context: (input.context ?? {}) as Prisma.InputJsonValue,
      askedById: actorId,
    },
  })
  await publishOutbox('LaptopQuestion', question.id, 'LaptopQuestionAsked', {
    workItemId: invocation.workItemId,
    laptopInvocationId: invocationId,
    questionId: question.id,
    actorId,
    traceId: `laptop-${invocationId}`,
  })
  return question
}

export async function getQuestionForActor(questionId: string, actorId: string) {
  const question = await prisma.laptopQuestion.findUnique({
    where: { id: questionId },
    include: { invocation: { include: { workItem: { include: { targets: true } } } } },
  })
  if (!question) throw new NotFoundError('LaptopQuestion', questionId)
  await assertCanViewWorkItem(actorId, question.invocation.workItem)
  return question
}

export async function answerLaptopQuestion(questionId: string, actorId: string, answer: string) {
  const question = await getQuestionForActor(questionId, actorId)
  if (question.status !== 'OPEN') throw new ValidationError(`Question is already ${question.status}`)
  if (!answer.trim()) throw new ValidationError('answer is required')
  const updated = await prisma.laptopQuestion.update({
    where: { id: questionId },
    data: {
      status: 'ANSWERED',
      answer: answer.trim(),
      answeredById: actorId,
      answeredAt: new Date(),
    },
  })
  await publishOutbox('LaptopQuestion', questionId, 'LaptopQuestionAnswered', {
    workItemId: question.workItemId,
    laptopInvocationId: question.invocationId,
    questionId,
    actorId,
    traceId: `laptop-${question.invocationId}`,
  })
  return updated
}

export async function waitForLaptopQuestion(questionId: string, actorId: string, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const question = await getQuestionForActor(questionId, actorId)
    if (question.status !== 'OPEN') return question
    await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  return getQuestionForActor(questionId, actorId)
}

export async function streamQuestions(invocationId: string, actorId: string, send: (payload: unknown) => void, signal: AbortSignal) {
  await loadInvocationForActor(invocationId, actorId)
  let lastSeen = new Date(0)
  while (!signal.aborted) {
    const questions = await prisma.laptopQuestion.findMany({
      where: { invocationId, createdAt: { gt: lastSeen } },
      orderBy: { createdAt: 'asc' },
      take: 25,
    })
    for (const question of questions) {
      lastSeen = question.createdAt
      send(question)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

let watchdogStarted = false

export function startLaptopHeartbeatWatchdog(): void {
  if (watchdogStarted) return
  watchdogStarted = true
  const sweepMs = config.LAPTOP_HEARTBEAT_SWEEP_SEC * 1000
  setInterval(() => {
    void (async () => {
      const cutoff = new Date(Date.now() - config.LAPTOP_HEARTBEAT_TIMEOUT_SEC * 1000)
      const stale = await prisma.laptopInvocation.findMany({
        where: {
          status: { in: ['STARTED', 'RUNNING'] },
          OR: [
            { lastHeartbeatAt: null, createdAt: { lt: cutoff } },
            { lastHeartbeatAt: { lt: cutoff } },
          ],
        },
        take: 100,
      })
      for (const invocation of stale) {
        await prisma.laptopInvocation.update({
          where: { id: invocation.id },
          data: { status: 'ENDED', endedAt: new Date() },
        })
        await publishOutbox('LaptopInvocation', invocation.id, 'LaptopSessionEnded', {
          workItemId: invocation.workItemId,
          agentRunId: invocation.agentRunId,
          laptopInvocationId: invocation.id,
          reason: 'heartbeat_timeout',
          traceId: `laptop-${invocation.id}`,
        })
      }
    })().catch(err => {
      console.warn('[laptop] heartbeat watchdog failed:', (err as Error).message)
    })
  }, sweepMs).unref()
}

export async function assertCanAccessInvocation(invocationId: string, actorId: string) {
  return loadInvocationForActor(invocationId, actorId)
}

export async function listLaptopInvocationsForWorkItem(workItemId: string, actorId: string) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, include: { targets: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(actorId, workItem)
  return prisma.laptopInvocation.findMany({
    where: { workItemId },
    include: { questions: { where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 10 } },
    orderBy: { createdAt: 'desc' },
  })
}

export function requireInvocationOwner(invocation: { userId: string | null }, actorId: string): void {
  if (invocation.userId && invocation.userId !== actorId) {
    throw new ForbiddenError('Only the owning laptop user can perform this action')
  }
}
