import { BlueprintStage, Prisma, type ApprovalRequest, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { workflowNodeTraceId } from '@workgraph/shared-types'
import { config } from '../../../../config'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { createReceipt, logEvent, publishOutbox } from '../../../../lib/audit'
import { redactSecrets } from '../../../../lib/redact'
import { requestOperationalMcpToolGrant } from './mcpToolGrant'
import { openPullRequestForRun } from './RaisePrExecutor'
import { resolveCapabilityRepo } from '../../../../lib/agent-and-tools/capability-repo'
import { resolveRuntimeTenantId } from '../../../../lib/runtime-tenant'
import { readUpstreamJsonBody, upstreamSnippet } from '../../../../lib/upstream-json'

type JsonObject = Record<string, unknown>
type WorkspaceEvidence = {
  branch?: string
  commitSha?: string
  patch?: string
  changedPaths: string[]
  workspaceRoot?: string
  codeChangeIds?: string[]
  source?: string
  warning?: string
  stageKey?: string
  attemptId?: string
  attemptNumber?: number
}

type GitPushOutput = {
  gitPush: {
    status: 'PUSHED' | 'COMMITTED_NOT_PUSHED' | 'BLOCKED'
    remote: string
    branch?: string
    commitSha?: string
    changedPaths: string[]
    pushed: boolean
    blockedCode?: string
    fixCommands?: string[]
    retryable?: boolean
    approvalRequired: boolean
    approvalRequestId?: string
    toolInvocationId?: string
    workspaceRoot?: string
    message: string
    pushError?: string
    evidenceSource?: string
    // P0 #2 — provenance only (issuanceId/provider/expiresAt/repo/operation/actor),
    // NEVER the token. Present only when the broker minted a credential for this
    // push; absent means the legacy static token was used.
    gitCredentialMetadata?: Record<string, unknown>
    // S4a — GIT_PUSH "open PR" flag. When node.config.openPr is set, after a
    // successful push we open a PR cloud-side via the shared connector helper.
    // The outcome is recorded here; a PR hiccup is NON-FATAL — the push already
    // succeeded and the node still advances.
    pullRequestUrl?: string | null
    pullRequestNumber?: number | null
    prError?: string
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

function rawStringAt(root: unknown, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((cursor, key) => {
    if (isRecord(cursor)) return cursor[key]
    return undefined
  }, root)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringsAt(root: unknown, path: string): string[] {
  const value = path.split('.').reduce<unknown>((cursor, key) => {
    if (isRecord(cursor)) return cursor[key]
    return undefined
  }, root)
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function numberAt(root: unknown, path: string): number | undefined {
  const value = path.split('.').reduce<unknown>((cursor, key) => {
    if (isRecord(cursor)) return cursor[key]
    return undefined
  }, root)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

async function readJsonObjectResponse(response: Response, source: string): Promise<{ body: JsonObject; raw: string } | { error: string; raw: string }> {
  const parsed = await readUpstreamJsonBody(response)
  if (!parsed.raw.trim()) return { body: {}, raw: parsed.raw }
  if (parsed.parseError) {
    return { error: `${source} returned invalid JSON (${parsed.parseError}): ${upstreamSnippet(parsed.raw, 700)}`, raw: parsed.raw }
  }
  if (isRecord(parsed.data)) return { body: parsed.data, raw: parsed.raw }
  return { error: `${source} returned a non-object response body`, raw: parsed.raw }
}

function findWorkspaceEvidence(value: unknown): WorkspaceEvidence {
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
    const workspaceRoot = stringAt(current, 'workspaceRoot')
      ?? stringAt(current, 'workspace.workspaceRoot')
      ?? stringAt(current, 'workspace.branch.workspaceRoot')
      ?? stringAt(current, 'gitPush.workspaceRoot')
    const codeChangeIds = stringsAt(current, 'codeChangeIds')
      .concat(stringsAt(current, 'correlation.codeChangeIds'))
      .concat(stringsAt(current, 'code_change_ids'))
    if (branch || commitSha || changedPaths.length > 0 || workspaceRoot || codeChangeIds.length > 0) {
      return {
        branch,
        commitSha,
        changedPaths: Array.from(new Set(changedPaths)),
        workspaceRoot,
        codeChangeIds: Array.from(new Set(codeChangeIds)),
        source: stringAt(current, 'cfCallId') ? 'agent-run-output' : 'workflow-context',
      }
    }
    for (const child of Object.values(current)) {
      if (isRecord(child) || Array.isArray(child)) stack.push(child)
    }
  }
  return { changedPaths: [] }
}

function hasWorkspaceEvidence(evidence: WorkspaceEvidence): boolean {
  return Boolean(
    evidence.branch
    || evidence.commitSha
    || evidence.workspaceRoot
    || evidence.changedPaths.length > 0
    || (evidence.codeChangeIds?.length ?? 0) > 0,
  )
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

function branchSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

function derivedWorkbenchBranch(
  instance: WorkflowInstance,
  evidence: WorkspaceEvidence,
  workItemCode?: string,
): string | undefined {
  if (evidence.branch && !isDefaultSourceBranch(evidence.branch)) return evidence.branch
  if (workItemCode) return `wi/${branchSegment(workItemCode, 'workitem')}`
  const hasWorkbenchCodeChange =
    (evidence.source ?? '').startsWith('blueprint-workbench')
    && ((evidence.codeChangeIds?.length ?? 0) > 0 || evidence.changedPaths.length > 0)
  if (!hasWorkbenchCodeChange) return undefined

  const stage = branchSegment(evidence.stageKey ?? 'develop', 'develop')
  const attempt = evidence.attemptId
    ? `${evidence.attemptNumber ?? 1}-${branchSegment(evidence.attemptId, 'attempt').slice(0, 12)}`
    : `${evidence.attemptNumber ?? 1}`
  return `sg/${branchSegment(instance.id, 'workflow')}/${stage}/${attempt}`.slice(0, 180)
}

function isDefaultSourceBranch(branch: string | undefined): boolean {
  return branch === 'main' || branch === 'master'
}

async function hydrateFromMcpFinishReceipt(evidence: WorkspaceEvidence): Promise<WorkspaceEvidence> {
  const ids = evidence.codeChangeIds ?? []
  if (ids.length === 0) return evidence

  for (const id of [...ids].reverse()) {
    try {
      const response = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/resources/tool-invocations/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) continue
      const parsed = await readJsonObjectResponse(response, 'MCP tool invocation receipt')
      if ('error' in parsed) continue
      const body = parsed.body
      const record = isRecord(body.data) ? body.data : {}
      if (stringAt(record, 'tool_name') !== 'finish_work_branch') continue
      const output = isRecord(record.output) ? record.output : {}
      return {
        ...evidence,
        branch: stringAt(output, 'branch') ?? evidence.branch,
        commitSha: stringAt(output, 'commit_sha') ?? stringAt(output, 'commitSha') ?? evidence.commitSha,
        patch: rawStringAt(output, 'patch') ?? evidence.patch,
        workspaceRoot: stringAt(output, 'workspaceRoot') ?? stringAt(output, 'workspace_root') ?? evidence.workspaceRoot,
        changedPaths: uniqueStrings([
          ...evidence.changedPaths,
          ...stringsAt(output, 'paths_touched'),
          ...stringsAt(output, 'changedPaths'),
          ...stringsAt(output, 'changed_paths'),
        ]),
      }
    } catch {
      // Best-effort enrichment only. If the Agent Runtime receipt has aged
      // out or the service is unavailable, the caller still falls back to
      // the artifact-level evidence and surfaces the usual retryable block.
    }
  }
  return evidence
}

function codeArtifactEvidence(payload: JsonObject, source: string): WorkspaceEvidence {
  const nested = findWorkspaceEvidence(payload)
  return {
    ...nested,
    changedPaths: uniqueStrings([
      ...nested.changedPaths,
      ...stringsAt(payload, 'paths'),
      ...stringsAt(payload, 'diff.paths'),
    ]),
    source,
    stageKey: stringAt(payload, 'stageKey') ?? nested.stageKey,
    attemptId: stringAt(payload, 'attemptId') ?? nested.attemptId,
    attemptNumber: numberAt(payload, 'version') ?? nested.attemptNumber,
  }
}

function consumableStatus(payload: JsonObject): string | undefined {
  return stringAt(payload, 'consumableStatus')
    ?? stringAt(payload, 'consumable.status')
    ?? stringAt(payload, 'consumablePublish.status')
}

function isApprovedCodeArtifact(payload: JsonObject): boolean {
  const status = consumableStatus(payload)
  return status === 'APPROVED' || status === 'ACCEPTED_WITH_RISK'
}

function isActualCodeArtifact(payload: JsonObject): boolean {
  return payload.actual === true && stringsAt(payload, 'codeChangeIds').length > 0
}

async function latestWorkbenchCodeChangeEvidence(instance: WorkflowInstance): Promise<WorkspaceEvidence | null> {
  const artifacts = await prisma.blueprintArtifact.findMany({
    where: {
      session: { workflowInstanceId: instance.id },
      stage: BlueprintStage.DEVELOPER,
      kind: 'actual_code_change',
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
    select: { payload: true },
  })
  if (artifacts.length === 0) return null

  const latest = artifacts[0]
  const payload = isRecord(latest?.payload) ? latest.payload : {}
  const evidence = codeArtifactEvidence(payload, 'blueprint-workbench-approved-code-change')
  if (!isActualCodeArtifact(payload) || !hasWorkspaceEvidence(evidence)) {
    return {
      changedPaths: [],
      source: 'blueprint-workbench-code-change-missing',
      warning: 'Latest Developer stage did not capture an actual MCP/git code change. Re-run Develop with a writable MCP workspace and approve the captured diff before Git Push.',
    }
  }

  if (!isApprovedCodeArtifact(payload)) {
    return {
      ...evidence,
      source: 'blueprint-workbench-code-change-unapproved',
      warning: 'Latest Developer code-change evidence is not approved yet. Approve the Workbench developer artifact before Git Push.',
    }
  }

  return hydrateFromMcpFinishReceipt(evidence)
}

async function latestWorkspaceEvidence(instance: WorkflowInstance): Promise<WorkspaceEvidence> {
  const workbenchCodeEvidence = await latestWorkbenchCodeChangeEvidence(instance)
  if (workbenchCodeEvidence) return workbenchCodeEvidence

  const contextEvidence = findWorkspaceEvidence(instance.context)
  if (hasWorkspaceEvidence(contextEvidence)) return contextEvidence

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
    if (hasWorkspaceEvidence(evidence)) return { ...evidence, source: 'agent-run-output' }
  }
  return contextEvidence
}

async function approvedGateForRun(
  instance: WorkflowInstance,
  node: WorkflowNode,
): Promise<ApprovalRequest | null> {
  const tenantId = instance.tenantId ?? undefined
  const approvalRequestId = cfgString(node, 'approvalRequestId')
  if (approvalRequestId) {
    return withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
      where: {
        id: approvalRequestId,
        instanceId: instance.id,
        status: { in: ['APPROVED', 'APPROVED_WITH_CONDITIONS'] },
      },
    }), tenantId)
  }
  return withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
    where: {
      instanceId: instance.id,
      status: { in: ['APPROVED', 'APPROVED_WITH_CONDITIONS'] },
    },
    orderBy: { updatedAt: 'desc' },
  }), tenantId)
}

async function blockNode(
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: GitPushOutput,
  actorId?: string,
): Promise<void> {
  const safeOutput = redactSecrets(output)
  const tenantId = instance.tenantId ?? undefined
  await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as JsonObject),
          _blockedByGitPush: safeOutput.gitPush,
        } as Prisma.InputJsonValue,
      },
    }),
    tx.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'GIT_PUSH_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: safeOutput as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ]), tenantId)
  await logEvent('GitPushBlocked', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    output: safeOutput,
  })
  await publishOutbox('WorkflowNode', node.id, 'GitPushBlocked', { instanceId: instance.id, nodeId: node.id, output: safeOutput })
}

function pushFixCommands(code: string, remote: string): string[] {
  if (code === 'GIT_AUTH_MISSING') {
    return [
      './singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote ' + remote,
      './singularity.sh doctor git',
      './singularity.sh restart mcp-server',
    ]
  }
  // M70.8 — Mirrors mcp-server's git-workspace.ts handling. When the
  // operator's token is good enough to authenticate but doesn't carry
  // Contents: Write, point them at the specific token-edit page
  // instead of generic "review the error" advice.
  if (code === 'GIT_AUTH_INSUFFICIENT_SCOPE') {
    return [
      'Your git token is authenticated but lacks Contents: Write on this repo.',
      'Fine-grained PAT (token starts with github_pat_...): https://github.com/settings/tokens?type=beta — edit the token, ensure the repo is in "Selected repositories", and set Repository permissions > Contents = Read and write.',
      'Classic PAT: https://github.com/settings/tokens — regenerate with the `repo` scope (full).',
      './singularity.sh restart mcp-server  # picks up the new token from .env',
    ]
  }
  if (code === 'GIT_REMOTE_UNREACHABLE') {
    return ['git remote -v', 'git remote set-url ' + remote + ' <ssh-or-https-repo-url>', './singularity.sh doctor git']
  }
  if (code === 'NO_COMMIT_TO_PUSH') {
    // (2026-05-29) Two distinct conditions reach this code: (1) no push
    // target could be resolved (no WorkItem, no branchName, no workspace
    // evidence), and (2) the Developer stage genuinely captured no diff
    // (or it's unapproved). The branch/WorkItem remedy leads because the
    // common dead-end is a run with no WorkItem and no branchName — the
    // old "re-run Develop" advice misled operators into re-running a stage
    // that had in fact produced edits.
    return [
      'Attach this run to a WorkItem, or set the Git Push node\'s branchName, so the push target is known.',
      'If the Developer stage did capture a diff, approve it (or re-run Develop on a writable MCP workspace) so the commit evidence is present.',
    ]
  }
  if (code === 'APPROVAL_REQUIRED') {
    return ['Complete the Human approval node before retrying Git Push.']
  }
  // M99 S1.4 — discrete codes mirrored from mcp-server's git-workspace.ts so
  // the workgraph-api fallback (used when mcp-server doesn't supply
  // push_fix_commands) gives the same precise guidance.
  if (code === 'GIT_BRANCH_PROTECTED') {
    return [
      'The target branch is protected — a direct push is refused by branch protection.',
      'Push to a feature branch (e.g. wi/<code>) and open a Pull Request to merge it.',
      'If a direct push is required, an admin must relax the branch-protection rule.',
    ]
  }
  if (code === 'GIT_NO_UPSTREAM') {
    return [
      'The local branch has no upstream tracking ref on ' + remote + '.',
      'git push -u ' + remote + ' <branch>   # sets the upstream on first push',
    ]
  }
  if (code === 'GIT_REMOTE_MISMATCH') {
    return [
      'Local and remote histories are unrelated — the remote likely points at a different repo.',
      'git remote -v   # confirm ' + remote + ' matches the work item source repo',
      'git remote set-url ' + remote + ' <correct-repo-url>   # if the remote is wrong',
    ]
  }
  return ['Review the Git push error, then retry the Git Push node.']
}

// P0 #2 — best-effort identity for the Git credential broker. Context Fabric's
// _maybe_broker_git_credential reads repo + tenant_id (+ user/capability) from
// the grant run_context and mints a short-lived, repo-scoped credential bound to
// the user's repository grant; it SKIPS brokering when repo or tenant is absent.
// So every field here is best-effort — a resolution miss simply leaves the
// legacy static-token path in place (fully back-compatible). Mirrors
// AgentTaskExecutor's capability/tenant/launcher/repo derivation so a GIT_PUSH
// attributes to the same identity the agent task ran under.
async function resolveGitBrokerIdentity(
  instance: WorkflowInstance,
  node: WorkflowNode,
  actorId?: string,
): Promise<{ capabilityId?: string; tenantId?: string; userId?: string; repo?: string }> {
  const context = (instance.context ?? {}) as JsonObject
  const vars = (isRecord(context._vars) ? context._vars : isRecord(context.vars) ? context.vars : {}) as JsonObject

  // Capability: node-pinned, else the work item's capability (parentCapabilityId).
  const workItemCapabilityId = typeof vars.parentCapabilityId === 'string' && vars.parentCapabilityId.trim()
    ? vars.parentCapabilityId.trim()
    : undefined
  const capabilityId = cfgString(node, 'capabilityId') ?? workItemCapabilityId

  const tenantId = resolveRuntimeTenantId({ nodeConfig: node.config, instanceContext: context })

  // User: the actor performing the push, else the instance creator. The broker
  // (and laptop routing) key on the IAM user id, not the workgraph-local id.
  const launcherLocalId = actorId ?? instance.createdById ?? undefined
  let userId: string | undefined = launcherLocalId ?? undefined
  if (launcherLocalId) {
    const launcher = await prisma.user
      .findUnique({ where: { id: launcherLocalId }, select: { iamUserId: true } })
      .catch(() => null)
    if (launcher?.iamUserId) userId = launcher.iamUserId
  }

  // Repo: per-item repoUrl var → capability's LINKED repo → node sourceUri.
  const fromVar = typeof vars.repoUrl === 'string' && vars.repoUrl.trim() ? vars.repoUrl.trim() : undefined
  const repo = fromVar
    ?? (capabilityId ? await resolveCapabilityRepo(capabilityId) : undefined)
    ?? cfgString(node, 'sourceUri')

  return { capabilityId, tenantId, userId, repo }
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
  workspaceRoot?: string
  expectedCommitSha?: string
  patch?: string
  approvalStatus: string
  actorId?: string
}): Promise<JsonObject> {
  const toolArgs = {
    message: args.message,
    push: true,
    remote: args.remote,
  }
  // P0 #2 — resolve repo/tenant/user/capability so Context Fabric can broker a
  // short-lived, repo-scoped git credential (best-effort; broker skips when repo
  // or tenant is absent, leaving the legacy static-token push path intact).
  const brokerIdentity = await resolveGitBrokerIdentity(args.instance, args.node, args.actorId)
  const runContext = {
    traceId: workflowNodeTraceId({
      prefix: 'git-push',
      workflowInstanceId: args.instance.id,
      workflowNodeId: args.node.id,
    }),
    runId: args.instance.id,
    workflowInstanceId: args.instance.id,
    nodeId: args.node.id,
    workItemId: args.workItemId,
    workItemCode: args.workItemCode,
    branchName: args.branchName,
    workspaceRoot: args.workspaceRoot,
    ...(brokerIdentity.capabilityId ? { capabilityId: brokerIdentity.capabilityId } : {}),
    ...(brokerIdentity.tenantId ? { tenantId: brokerIdentity.tenantId } : {}),
    ...(brokerIdentity.userId ? { userId: brokerIdentity.userId } : {}),
    ...(brokerIdentity.repo ? { repo: brokerIdentity.repo } : {}),
  }
  const { grant: toolGrant, gitCredential } = await requestOperationalMcpToolGrant({
    toolName: 'finish_work_branch',
    args: toolArgs,
    runContext,
    workflowPolicy: {
      nodeType: 'GIT_PUSH',
      stageKey: 'GIT_PUSH',
      approvalStatus: args.approvalStatus,
    },
  })
  const payload = {
    ...toolArgs,
    expectedCommitSha: args.expectedCommitSha,
    patch: args.patch,
    runContext,
    ...(toolGrant ? { tool_grant: toolGrant } : {}),
    // P0 #2 — brokered credential rides to CF, which forwards it to the
    // shared/co-located mcp-server for the push (a dialed-in personal laptop uses
    // its own local creds, so CF does NOT forward it over the bridge frame).
    ...(gitCredential ? { gitCredential } : {}),
  }
  // Route the finalize (commit + push) through Context Fabric — dial-in aware:
  // the laptop pushes with its LOCAL git creds, else CF falls back to the shared
  // mcp-server. Fall back to direct mcp HTTP here only when CF is unconfigured /
  // unreachable / errors (debug + back-compat).
  const cfUrl = config.CONTEXT_FABRIC_URL?.replace(/\/$/, '')
  // Capture WHY the CF path failed — it's the correct hybrid route (CF relays to the
  // laptop mcp that holds the repo + local git creds), so its failure is the real,
  // actionable cause. Without this it was swallowed and the block showed only the
  // fallback's generic "fetch failed".
  let cfFailure = 'Context Fabric not configured (CONTEXT_FABRIC_URL unset)'
  if (cfUrl) {
    let cfResp: Response | null = null
    try {
      cfResp = await fetch(`${cfUrl}/api/runtime-bridge/work/finish-branch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '' },
        body: JSON.stringify(payload),
      })
    } catch (cfErr) {
      cfFailure = `Context Fabric unreachable at ${cfUrl}: ${(cfErr as Error).message}`
    }
    if (cfResp?.ok) {
      const parsed = await readJsonObjectResponse(cfResp, 'Context Fabric finish-branch')
      if ('error' in parsed) throw new Error(redactSecrets(parsed.error))
      // CF returns { tool_invocation, output }; callers read body.data.*.
      return { success: true, data: parsed.body }
    }
    if (cfResp) {
      // CF reachable but errored (commonly: no laptop runtime connected to the bridge
      // for the finish-branch frame). Record the reason, then try the direct fallback.
      const parsed = await readJsonObjectResponse(cfResp, 'Context Fabric finish-branch')
      const detail = 'error' in parsed ? parsed.error : parsed.raw
      cfFailure = `Context Fabric finish-branch HTTP ${cfResp.status}: ${redactSecrets(String(detail)).slice(0, 300)}`
    }
  }
  let response: Response
  try {
    response = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/work/finish-branch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (mcpErr) {
    // Both relays failed. Surface the CF reason (actionable) alongside the fallback
    // error, so the block is a diagnosis instead of a bare "fetch failed".
    throw new Error(redactSecrets(
      `push relay unreachable. Context Fabric path: [${cfFailure}]. ` +
      `Direct mcp fallback (${config.MCP_SERVER_URL}): ${(mcpErr as Error).message} ` +
      `— in a cloud+laptop split, pushes must go via Context Fabric to the connected laptop runtime.`,
    ))
  }
  const parsed = await readJsonObjectResponse(response, 'MCP finish-branch')
  if (!response.ok) {
    throw new Error(redactSecrets(`MCP /work/finish-branch failed (${response.status}): ${parsed.raw}`))
  }
  if ('error' in parsed) throw new Error(redactSecrets(parsed.error))
  return parsed.body
}

/**
 * S3 — per-phase working-tree push. A thin, NON-THROWING wrapper over
 * callMcpFinishWorkBranch so a stage/artifact-completion hook can push the
 * wi/<code> working tree through the runtime WITHOUT the terminal GIT_PUSH node's
 * evidence/blocking machinery. Returns { ok:false, error } instead of throwing —
 * callers fire it fire-and-forget; a push failure (commonly: the dial-in bridge
 * is down) must never disturb the transition it reacts to.
 */
export async function pushWorkBranchForStage(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  workItemId?: string
  workItemCode?: string
  branchName?: string
  message: string
  actorId?: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await callMcpFinishWorkBranch({
      instance: args.instance,
      node: args.node,
      remote: 'origin',
      message: args.message,
      workItemId: args.workItemId,
      workItemCode: args.workItemCode,
      branchName: args.branchName,
      approvalStatus: 'NOT_REQUIRED',
      actorId: args.actorId,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
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
  const evidenceBranch = isDefaultSourceBranch(evidence.branch) ? undefined : evidence.branch
  const workItemId = cfgString(node, 'workItemId')
    ?? stringAt(workItem, 'id')
  const workItemCode = cfgString(node, 'workItemCode')
    ?? stringAt(workItem, 'workCode')
  const branchName = cfgString(node, 'branchName')
    ?? evidenceBranch
    ?? stringAt(context, 'workspaceBranch')
    ?? derivedWorkbenchBranch(instance, evidence, workItemCode)
  const message = cfgString(node, 'message')
    ?? `Push Singularity work ${workItemCode ?? workItemId ?? instance.id}`
  let approvalStatus = 'NOT_REQUIRED'

  if (evidence.warning) {
    const output: GitPushOutput = {
      gitPush: {
        status: 'BLOCKED',
        remote,
        branch: branchName,
        commitSha: evidence.commitSha,
        changedPaths: evidence.changedPaths,
        workspaceRoot: evidence.workspaceRoot,
        pushed: false,
        blockedCode: 'NO_COMMIT_TO_PUSH',
        fixCommands: pushFixCommands('NO_COMMIT_TO_PUSH', remote),
        retryable: true,
        approvalRequired: requireApproval,
        message: evidence.warning,
        evidenceSource: evidence.source,
      },
    }
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

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
        workspaceRoot: evidence.workspaceRoot,
        pushed: false,
        blockedCode: 'APPROVAL_REQUIRED',
        fixCommands: pushFixCommands('APPROVAL_REQUIRED', remote),
        retryable: true,
        approvalRequired: true,
        message: 'Git push requires a prior approved workflow approval gate. Add/complete an APPROVAL node before this GIT_PUSH node, or set requireApproval=false for controlled automation.',
        evidenceSource: evidence.source,
        },
      }
      await blockNode(instance, node, output, actorId)
      return { pushed: false, output }
    }
    approvalStatus = approved.status
  }

  if (!branchName && !workItemId && !workItemCode && !evidence.workspaceRoot) {
    const output: GitPushOutput = {
      gitPush: {
        status: 'BLOCKED',
        remote,
        changedPaths: evidence.changedPaths,
        workspaceRoot: evidence.workspaceRoot,
        pushed: false,
        blockedCode: 'NO_COMMIT_TO_PUSH',
        fixCommands: pushFixCommands('NO_COMMIT_TO_PUSH', remote),
        retryable: true,
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
      workItemCode: evidence.workspaceRoot ? undefined : workItemCode,
      branchName,
      workspaceRoot: evidence.workspaceRoot,
      expectedCommitSha: evidence.commitSha,
      patch: evidence.patch,
      approvalStatus,
      actorId,
    })
  } catch (err) {
    const output: GitPushOutput = {
      gitPush: {
        status: 'BLOCKED',
        remote,
        branch: branchName,
        commitSha: evidence.commitSha,
        changedPaths: evidence.changedPaths,
        workspaceRoot: evidence.workspaceRoot,
        pushed: false,
        blockedCode: 'GIT_PUSH_REJECTED',
        fixCommands: pushFixCommands('GIT_PUSH_REJECTED', remote),
        retryable: true,
        approvalRequired: requireApproval,
        message: redactSecrets((err as Error).message),
        evidenceSource: evidence.source,
      },
    }
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

  const data = isRecord(body.data) ? body.data : {}
  const toolInvocation = isRecord(data.tool_invocation) ? data.tool_invocation : {}
  // P0 #2 — mcp-server already returns this on the tool_invocation record
  // (provenance only: issuanceId/provider/expiresAt/repo/operation/actor — NEVER
  // the token). Surfacing it here makes "was this push brokered or static" visible
  // on the node output/receipt instead of only living in mcp-server's local audit
  // journal.
  const gitCredentialMetadata = isRecord(toolInvocation.gitCredentialMetadata)
    ? toolInvocation.gitCredentialMetadata
    : undefined
  const mcpOutput = isRecord(data.output) ? data.output : {}
  const pushed = mcpOutput.pushed === true
  const pushError = typeof mcpOutput.push_error === 'string' && mcpOutput.push_error.trim()
    ? redactSecrets(mcpOutput.push_error.trim())
    : undefined
  const commitSha = typeof mcpOutput.commit_sha === 'string' ? mcpOutput.commit_sha : evidence.commitSha
  const blockedCode = typeof mcpOutput.push_blocked_code === 'string' && mcpOutput.push_blocked_code.trim()
    ? mcpOutput.push_blocked_code.trim()
    : (!pushed ? 'GIT_PUSH_REJECTED' : undefined)
  const fixCommands = Array.isArray(mcpOutput.push_fix_commands)
    ? mcpOutput.push_fix_commands.map(String).map(command => redactSecrets(command))
    : (blockedCode ? pushFixCommands(blockedCode, remote) : undefined)
  const retryable = typeof mcpOutput.push_retryable === 'boolean'
    ? mcpOutput.push_retryable
    : (!pushed && Boolean(commitSha))
  const output: GitPushOutput = {
    gitPush: {
      status: pushed ? 'PUSHED' : (commitSha ? 'COMMITTED_NOT_PUSHED' : 'BLOCKED'),
      remote: typeof mcpOutput.remote === 'string' ? redactSecrets(mcpOutput.remote) : remote,
      branch: typeof mcpOutput.branch === 'string' ? mcpOutput.branch : branchName,
      commitSha,
      changedPaths: Array.isArray(mcpOutput.paths_touched)
        ? mcpOutput.paths_touched.map(String)
        : evidence.changedPaths,
      pushed,
      blockedCode,
      fixCommands,
      retryable,
      approvalRequired: requireApproval,
      toolInvocationId: typeof toolInvocation.id === 'string' ? toolInvocation.id : undefined,
      workspaceRoot: typeof mcpOutput.workspaceRoot === 'string' ? mcpOutput.workspaceRoot : evidence.workspaceRoot,
      message: typeof mcpOutput.message === 'string' ? redactSecrets(mcpOutput.message) : message,
      pushError,
      evidenceSource: evidence.source,
      gitCredentialMetadata,
    },
  }

  if (!pushed || pushError) {
    await blockNode(instance, node, output, actorId)
    return { pushed: false, output }
  }

  const safeOutput = redactSecrets(output)
  // Mirrors blockNode's `_blockedByGitPush` context write, but for a SUCCESSFUL
  // push: GitPushExecutor otherwise leaves no trace of a completed push in
  // instance.context (only the receipt below), so the run cockpit has nothing to
  // read credential provenance from for the common case. Best-effort: a failure
  // here must not fail the push that already succeeded.
  await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
    where: { id: instance.id },
    data: {
      context: {
        ...((instance.context ?? {}) as JsonObject),
        _lastGitPush: safeOutput.gitPush,
      } as Prisma.InputJsonValue,
    },
  }), instance.tenantId ?? undefined).catch(() => {})
  const eventId = await logEvent('GitBranchPushed', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    output: safeOutput,
  })
  await createReceipt('GIT_BRANCH_PUSHED', 'WorkflowNode', node.id, {
    instanceId: instance.id,
    nodeId: node.id,
    gitPush: safeOutput.gitPush,
  }, eventId)
  await publishOutbox('WorkflowNode', node.id, 'GitBranchPushed', {
    instanceId: instance.id,
    nodeId: node.id,
    output: safeOutput,
  })

  // S4a — optional "open PR" after a successful push. Cloud-side via the shared
  // connector helper (same one the RAISE_PR node uses). NON-FATAL: the outcome is
  // recorded on the output + its own event, but a PR failure never un-does the
  // push, which has already succeeded and will advance the run.
  if (cfgBool(node, 'openPr', false)) {
    const globals = isRecord(context._globals) ? context._globals : {}
    const vars = isRecord(context._vars) ? context._vars : {}
    const head = output.gitPush.branch ?? branchName
    const base = cfgString(node, 'prBase') ?? stringAt(globals, 'sourceRef') ?? 'main'
    const repoUrl = cfgString(node, 'repoUrl') ?? stringAt(vars, 'repoUrl') ?? stringAt(globals, 'repoUrl')
    const title = cfgString(node, 'prTitle') ?? `${workItemCode ?? workItemId ?? 'Delivery'}: automated delivery`
    const body = cfgString(node, 'prBody')
      ?? `Opened automatically after the Git Push for ${workItemCode ?? instance.id}.\n\nHead: \`${head ?? '(unknown)'}\` → Base: \`${base}\`.`
    if (!head) {
      output.gitPush.prError = 'open PR skipped: the pushed branch name could not be resolved.'
    } else {
      const pr = await openPullRequestForRun({ head, base, title, body, repoUrl })
      if (pr.ok) {
        output.gitPush.pullRequestUrl = pr.url ?? null
        output.gitPush.pullRequestNumber = pr.number ?? null
        await logEvent('GitPushPrOpened', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, head, base, url: pr.url, number: pr.number })
      } else {
        output.gitPush.prError = pr.reason
        await logEvent('GitPushPrFailed', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, head, base, reason: pr.reason })
      }
    }
  }

  return { pushed: true, output }
}
