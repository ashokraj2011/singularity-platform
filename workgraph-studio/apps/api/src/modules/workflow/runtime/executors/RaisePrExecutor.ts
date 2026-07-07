import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent } from '../../../../lib/audit'
import { buildAdapter } from '../../../connectors/connector.service'

type JsonObject = Record<string, unknown>

function isRecord(v: unknown): v is JsonObject {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function asObject(v: unknown): JsonObject {
  return isRecord(v) ? v : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

// Parse owner/repo from a github/gitlab URL (best-effort). Mirrors the helper in
// connectors.router.ts so the launch branch-list and PR-raise agree on parsing.
function parseOwnerRepo(url: string): { owner?: string; repo?: string } {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : {}
}

export type OpenPrResult = { ok: boolean; url?: string; number?: number; reason?: string }

/**
 * Open a pull request for a run — CLOUD-SIDE, via the configured GitHub/GitLab
 * connector's `openPR` op. Does NOT touch the laptop runtime, so it works even
 * when the dial-in bridge is down (as long as the head branch already exists on
 * the remote — e.g. pushed by GIT_PUSH or by the per-phase cloud artifact commit).
 *
 * Shared by the RAISE_PR node (below) and the GIT_PUSH node's "open PR" flag.
 * Never throws — returns { ok:false, reason } so callers can surface a clean,
 * recoverable block reason instead of a stack trace.
 */
export async function openPullRequestForRun(opts: {
  head: string
  base: string
  title: string
  body?: string
  repoUrl?: string
}): Promise<OpenPrResult> {
  const connector = await prisma.connector.findFirst({
    where: { type: 'GIT', archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!connector) {
    return { ok: false, reason: 'No GIT connector is configured — add one at Connectors to open pull requests.' }
  }
  const cfg = asObject(connector.config) as { defaultOwner?: string; defaultRepo?: string }
  const parsed = opts.repoUrl ? parseOwnerRepo(opts.repoUrl) : {}
  const owner = parsed.owner ?? cfg.defaultOwner
  const repo = parsed.repo ?? cfg.defaultRepo
  try {
    const adapter = buildAdapter(connector.type, connector.config as JsonObject, connector.credentials as JsonObject)
    const pr = await adapter.invoke('openPR', {
      title: opts.title,
      body: opts.body ?? '',
      head: opts.head,
      base: opts.base,
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
    }) as { html_url?: string; web_url?: string; number?: number; iid?: number }
    return { ok: true, url: pr.html_url ?? pr.web_url, number: pr.number ?? pr.iid }
  } catch (e) {
    // GitHub returns 422 when the head branch doesn't exist yet or a PR is already
    // open for it; surface that message rather than a raw stack.
    const anyErr = e as { response?: { data?: { message?: string; errors?: unknown } }; message?: string }
    const reason = anyErr?.response?.data?.message ?? anyErr?.message ?? String(e)
    return { ok: false, reason }
  }
}

/**
 * RAISE_PR node executor. Opens a PR from the run's work branch (wi/<workCode>,
 * or a config override) into the base branch, via openPullRequestForRun.
 *
 * Contract mirrors the other gate-style executors: returns { raised } and lets
 * WorkflowRuntime advance on success. On failure it THROWS a clean message so the
 * runtime degrades the node to BLOCKED (recoverable: fix + retry / skip), exactly
 * like GIT_PUSH — a PR hiccup must never strand a run.
 */
export async function activateRaisePr(
  node: WorkflowNode,
  instance: WorkflowInstance,
  _actorId: string | null,
): Promise<{ raised: boolean; output?: JsonObject }> {
  const config = asObject(node.config)
  const context = asObject(instance.context)
  const vars = asObject(context._vars)
  const globals = asObject(context._globals)
  const workItem = asObject(context._workItem)

  const workCode = str(workItem.workCode) ?? str(vars.workCode) ?? str(vars.workItemCode)
  const head = str(config.head) ?? str(config.branchName) ?? (workCode ? `wi/${workCode}` : undefined)
  if (!head) {
    throw new Error('RAISE_PR: no head branch — the run has no work-item code and no branch is configured on the node.')
  }
  // Base: node config wins, else the branch this run cloned (launch pick), else main.
  const base = str(config.base) ?? str(config.baseBranch) ?? str(globals.sourceRef) ?? 'main'
  const repoUrl = str(config.repoUrl) ?? str(vars.repoUrl) ?? str(globals.repoUrl)
  const title = str(config.title)
    ?? (workCode ? `${workCode}: ${str(workItem.title) ?? 'automated delivery'}` : 'Automated delivery')
  const body = str(config.body)
    ?? `Opened automatically by the SDLC workflow for ${workCode ?? 'this run'}.\n\nHead: \`${head}\` → Base: \`${base}\`.`

  const result = await openPullRequestForRun({ head, base, title, body, repoUrl })

  if (!result.ok) {
    await logEvent('RaisePrFailed', 'WorkflowNode', node.id, undefined, {
      instanceId: instance.id, head, base, reason: result.reason,
    })
    // Thrown → WorkflowRuntime.degradeNodeToBlocked → node BLOCKED with this reason.
    throw new Error(`RAISE_PR: ${result.reason ?? 'could not open pull request'} (head=${head} → base=${base})`)
  }

  await logEvent('RaisePrOpened', 'WorkflowNode', node.id, undefined, {
    instanceId: instance.id, head, base, url: result.url, number: result.number,
  })
  return {
    raised: true,
    output: { raisedPr: true, pullRequestUrl: result.url ?? null, pullRequestNumber: result.number ?? null, head, base },
  }
}
