import { Prisma, type ApprovalRequest, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { config } from '../../../../config'
import { prisma } from '../../../../lib/prisma'
import { createReceipt, logEvent, publishOutbox } from '../../../../lib/audit'

type JsonObject = Record<string, unknown>

type GitPushOutput = {
  gitPush: {
    status: 'PUSHED' | 'BLOCKED'
    remote: string
    branch?: string
    commitSha?: string
    changedPaths: string[]
    pushed: boolean
    approvalRequired: boolean
    approvalRequestId?: string
    toolInvocationId?: string
    workspaceRoot?: string
    message: string
    pushError?: string
    evidenceSource?: string
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, key: string): string | undefined {
  const value = cfgValue(node, key)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return fallback
}

function stringAt(root: unknown, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((cursor, key) => {
    if (isRecord(cursor)) return cursor[key]
    return undefined
  }, root)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringsAt(root: unknown, path: string): string[] {
  const value = path.split('.').reduce<unknown>((cursor, key) => {
    if (isRecord(cursor)) return cursor[key]
    return undefined
  }, root)
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function findWorkspaceEvidence(value: unknown): {
  branch?: string
  commitSha?: string
  changedPaths: string[]
  source?: string
} {
  const stack: unknown[] = [value]
  const seen = new Set<unknown>()
  while (stack.length > 0) {
    const current = stack.shift()
    if (!isRecord(current) || seen.has(current)) continue
    seen.add(current)
    const branch = stringAt(current, 'workspaceBranch')
      ?? stringAt(current, 'workspace.workspaceBranch')
      ?? stringAt(current, 'gitPush.branch')
      ?? stringAt(current, 'branch')
    const commitSha = stringAt(current, 'workspaceCommitSha')
      ?? stringAt(current, 'workspace.workspaceCommitSha')
      ?? stringAt(current, 'gitPush.commitSha')
      ?? stringAt(current, 'commit_sha')
      ?? stringAt(current, 'commitSha')
    const changedPaths = stringsAt(current, 'changedPaths')
      .concat(stringsAt(current, 'workspace.changedPaths'))
      .concat(stringsAt(current, 'gitPush.changedPaths'))
      .concat(stringsAt(current, 'paths_touched'))
    if (branch || commitSha || changedPaths.length > 0) {
      return {
        branch,
        commitSha,
        changedPaths: Array.from(new Set(changedPaths)),
        source: stringAt(current, 'cfCallId') ? 'agent-run-output' : 'workflow-context',
      }
    }
    for (const child of Object.values(current)) {
      if (isRecord(child) || Array.isArray(child)) stack.push(child)
    }
  }
  return { changedPaths: [] }
}

async function latestWorkspaceEvidence(instance: WorkflowInstance): Promise<ReturnType<typeof findWorkspaceEvidence>> {
  const contextEvidence = findWorkspaceEvidence(instance.context)
  if (contextEvidence.branch || contextEvidence.commitSha || contextEvidence.changedPaths.length > 0) {
    return contextEvidence
  }
  const outputs = await prisma.agentRunOutput.findMany({
    where: {
      run: { instanceId: instance.id },
      outputType: { in: ['LLM_RESPONSE', 'APPROVAL_REQUIRED', 'EXECUTION_TRACE'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { structuredPayload: true },
  })
  for (const output of outputs) {
    const evidence = findWorkspaceEvidence(output.structuredPayload)
    if (evidence.branch || evidence.commitSha || evidence.changedPaths.length > 0) return evidence
  }
  return contextEvidence
}

async function approvedGateForRun(
  instance: WorkflowInstance,
  node: WorkflowNode,
): Promise<ApprovalRequest | null> {
  const approvalRequestId = cfgString(node, 'approvalRequestId')
  if (approvalRequestId) {
    return prisma.approvalRequest.findFirst({
      where: {
        id: approvalRequestId,
        instanceId: instance.id,
        status: { in: ['APPROVED', 'APPROVED_WITH_CONDITIONS'] },
      },
    })
  }
  return prisma.approvalRequest.findFirst({
    where: {
      instanceId: instance.id,
      status: { in: ['APPROVED', 'APPROVED_WITH_CONDITIONS'] },
    },
    orderBy: { updatedAt: 'desc' },
  })
}

async function blockNode(
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: GitPushOutput,
  actorId?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    prisma.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as JsonObject),
          _blockedByGitPush: output.gitPush,
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'GIT_PUSH_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('GitPushBlocked', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    output,
  })
  await publishOutbox('WorkflowNode', node.id, 'GitPushBlocked', { instanceId: instance.id, nodeId: node.id, output })
}

// M37.1 — Uses the purpose-built POST /mcp/work/finish-branch endpoint
// instead of the generic /mcp/tools/call bypass with a hardcoded tool name.
// The tool name now lives in mcp-server (as the implementation behind the
// named endpoint); the executor just describes WHAT it wants done.
async function callMcpFinishWorkBranch(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  remote: string
  message: string
  workItemId?: string
  workItemCode?: string
  branchName?: string
}): Promise<JsonObject> {
  const response = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/work/finish-branch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
    },
    body: JSON.stringify({
      message: args.message,
      push: true,
      remote: args.remote,
      runContext: {
        traceId: `git-push-${args.instance.id}-${args.node.id}`,
        runId: args.instance.id,
        workflowInstanceId: args.instance.id,
        nodeId: args.node.id,
        workItemId: args.workItemId,
        workItemCode: args.workItemCode,
        branchName: args.branchName,
      },
    }),
  })
  const text = await response.text()
  let body: JsonObject = {}
  try {
    body = text ? JSON.parse(text) as JsonObject : {}
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`MCP /work/finish-branch failed (${response.status}): ${text}`)
  }
  return body
}

export async function activateGitPush(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ pushed: boolean; output: GitPushOutput }> {
  const remote = cfgString(node, 'remote') ?? 'origin'
  const requireApproval = cfgBool(node, 'requireApproval', true)
  const context = (instance.context ?? {}) as JsonObject
  const workItem = isRecord(context._workItem) ? context._workItem : {}
  const evidence = await latestWorkspaceEvidence(instance)
  const workItemId = cfgString(node, 'workItemId')
    ?? stringAt(workItem, 'id')
  const workItemCode = cfgString(node, 'workItemCode')
    ?? stringAt(workItem, 'workCode')
  const branchName = cfgString(node, 'branchName')
    ?? evidence.branch
    ?? stringAt(context, 'workspaceBranch')
    ?? (workItemCode ? `work/${workItemCode}` : undefined)
  const message = cfgString(node, 'message')
    ?? `Push Singularity work ${workItemCode ?? workItemId ?? instance.id}`

  if (requireApproval) {
    const approved = await approvedGateForRun(instance, node)
    if (!approved) {
      const output: GitPushOutput = {
        gitPush: {
          status: 'BLOCKED',
          remote,
          branch: branchName,
          commitSha: evidence.commitSha,
          changedPaths: evidence.changedPaths,
          pushed: false,
          approvalRequired: true,
          message: 'Git push requires a prior approved workflow approval gate. Add/complete an APPROVAL node before this GIT_PUSH node, or set requireApproval=false for controlled automation.',
          evidenceSource: evidence.source,
        },
      }
      await blockNode(instance, node, output, actorId)
      return { pushed: false, output }
    }
  }

  if (!branchName && !workItemId && !workItemCode) {
    const output: GitPushOutput = {
      gitPush: {
        status: 'BLOCKED',
        remote,
        changedPaths: evidence.changedPaths,
        pushed: false,
        approvalRequired: requireApproval,
        message: 'No WorkItem or branch was found. Configure branchName, run from a WorkItem, or ensure the coding agent returned workspaceBranch evidence.',
        evidenceSource: evidence.source,
      },
    }
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

  let body: JsonObject
  try {
    body = await callMcpFinishWorkBranch({
      instance,
      node,
      remote,
      message,
      workItemId,
      workItemCode,
      branchName,
    })
  } catch (err) {
    const output: GitPushOutput = {
      gitPush: {
        status: 'BLOCKED',
        remote,
        branch: branchName,
        commitSha: evidence.commitSha,
        changedPaths: evidence.changedPaths,
        pushed: false,
        approvalRequired: requireApproval,
        message: (err as Error).message,
        evidenceSource: evidence.source,
      },
    }
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

  const data = isRecord(body.data) ? body.data : {}
  const toolInvocation = isRecord(data.tool_invocation) ? data.tool_invocation : {}
  const mcpOutput = isRecord(data.output) ? data.output : {}
  const pushed = mcpOutput.pushed === true
  const pushError = typeof mcpOutput.push_error === 'string' && mcpOutput.push_error.trim()
    ? mcpOutput.push_error.trim()
    : undefined
  const output: GitPushOutput = {
    gitPush: {
      status: pushed ? 'PUSHED' : 'BLOCKED',
      remote,
      branch: typeof mcpOutput.branch === 'string' ? mcpOutput.branch : branchName,
      commitSha: typeof mcpOutput.commit_sha === 'string' ? mcpOutput.commit_sha : evidence.commitSha,
      changedPaths: Array.isArray(mcpOutput.paths_touched)
        ? mcpOutput.paths_touched.map(String)
        : evidence.changedPaths,
      pushed,
      approvalRequired: requireApproval,
      toolInvocationId: typeof toolInvocation.id === 'string' ? toolInvocation.id : undefined,
      workspaceRoot: typeof mcpOutput.workspaceRoot === 'string' ? mcpOutput.workspaceRoot : undefined,
      message: typeof mcpOutput.message === 'string' ? mcpOutput.message : message,
      pushError,
      evidenceSource: evidence.source,
    },
  }

  if (!pushed || pushError) {
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

  const eventId = await logEvent('GitBranchPushed', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    output,
  })
  await createReceipt('GIT_BRANCH_PUSHED', 'WorkflowNode', node.id, {
    instanceId: instance.id,
    nodeId: node.id,
    gitPush: output.gitPush,
  }, eventId)
  await publishOutbox('WorkflowNode', node.id, 'GitBranchPushed', {
    instanceId: instance.id,
    nodeId: node.id,
    output,
  })

  return { pushed: true, output }
}
