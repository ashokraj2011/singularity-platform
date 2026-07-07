import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent } from '../../../../lib/audit'
import { buildAdapter } from '../../../connectors/connector.service'

type JsonObject = Record<string, unknown>
const isRecord = (v: unknown): v is JsonObject => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const asObject = (v: unknown): JsonObject => (isRecord(v) ? v : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

// Parse owner/repo from a github/gitlab URL (best-effort; mirrors RaisePrExecutor).
function parseOwnerRepo(url: string): { owner?: string; repo?: string } {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : {}
}

/**
 * CREATE_BRANCH node executor. Creates the run's work branch (wi/<workCode>, or a
 * config override) from the base branch — CLOUD-SIDE via the GitHub connector's
 * createBranch. Meant to run at the START of a flow so the branch exists up-front
 * for the per-phase commits and the final push / PR.
 *
 * Idempotent: an already-existing branch is treated as success (the runtime
 * materializer or a prior run may have created it). Contract mirrors RAISE_PR —
 * returns { created } and lets WorkflowRuntime advance; on a real failure it
 * throws a clean reason so the runtime degrades the node to BLOCKED (recoverable),
 * never stranding the run.
 */
export async function activateCreateBranch(
  node: WorkflowNode,
  instance: WorkflowInstance,
  _actorId: string | null,
): Promise<{ created: boolean; output?: JsonObject }> {
  const config = asObject(node.config)
  const context = asObject(instance.context)
  const vars = asObject(context._vars)
  const globals = asObject(context._globals)
  const workItem = asObject(context._workItem)

  const workCode = str(workItem.workCode) ?? str(vars.workCode) ?? str(vars.workItemCode)
  const branch = str(config.branchName) ?? (workCode ? `wi/${workCode}` : undefined)
  if (!branch) {
    throw new Error('CREATE_BRANCH: no branch — the run has no work-item code and no branchName is configured on the node.')
  }
  // Base: node config wins, else the branch this run cloned (launch pick), else main.
  const fromBranch = str(config.base) ?? str(config.fromBranch) ?? str(globals.sourceRef) ?? 'main'
  const repoUrl = str(config.repoUrl) ?? str(vars.repoUrl) ?? str(vars.sourceUri) ?? str(globals.repoUrl)

  const connector = await prisma.connector.findFirst({
    where: { type: 'GIT', archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!connector) {
    throw new Error('CREATE_BRANCH: no GIT connector is configured — add one at Connectors to create branches cloud-side.')
  }
  const cfg = asObject(connector.config) as { defaultOwner?: string; defaultRepo?: string }
  const parsed = repoUrl ? parseOwnerRepo(repoUrl) : {}
  const owner = parsed.owner ?? cfg.defaultOwner
  const repo = parsed.repo ?? cfg.defaultRepo

  try {
    const adapter = buildAdapter(connector.type, connector.config as JsonObject, connector.credentials as JsonObject)
    await adapter.invoke('createBranch', {
      branchName: branch,
      fromBranch,
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
    })
    await logEvent('WorkBranchCreated', 'WorkflowNode', node.id, undefined, { instanceId: instance.id, branch, fromBranch })
    return { created: true, output: { workBranch: branch, fromBranch, branchExisted: false } }
  } catch (e) {
    const anyErr = e as { response?: { data?: { message?: string } }; message?: string }
    const msg = anyErr?.response?.data?.message ?? anyErr?.message ?? String(e)
    // Idempotent: an already-existing branch (GitHub "Reference already exists") is
    // success — the branch is there, which is all this node needs to guarantee.
    if (/already exists/i.test(msg)) {
      await logEvent('WorkBranchExists', 'WorkflowNode', node.id, undefined, { instanceId: instance.id, branch, fromBranch })
      return { created: true, output: { workBranch: branch, fromBranch, branchExisted: true } }
    }
    await logEvent('WorkBranchCreateFailed', 'WorkflowNode', node.id, undefined, { instanceId: instance.id, branch, fromBranch, reason: msg })
    throw new Error(`CREATE_BRANCH: ${msg} (branch=${branch} from ${fromBranch})`)
  }
}
