/**
 * Minimal closed learning loop — run-outcome → capability memory.
 *
 * On a terminal workflow event (COMPLETED / FAILED / CANCELLED) we gather a
 * DETERMINISTIC summary of the run — stage outcomes, friction mutations
 * (retries / send-backs / gate blocks) and artifacts produced — with NO LLM or
 * context-fabric dependency, and persist it as a CAPABILITY-scoped
 * DistilledMemory via the agent-runtime memory API.
 *
 * The prompt composer already reads ACTIVE capability memories into the next
 * run's MEMORY_CONTEXT layer (compose.service.ts → `{ scopeType: 'CAPABILITY',
 * scopeId, status: 'ACTIVE' }`, recency-ordered; FTS + semantic once the
 * embedding reconciler backfills). So each run teaches the next one what just
 * happened — the loop closes with one row, no new service.
 *
 * Fire-and-forget by contract: callers MUST `void` this and never await it on
 * the run's critical path. It swallows its own errors; a learning-write failure
 * must never fail or slow a workflow.
 */
import { prisma } from '../prisma'
import { config } from '../../config'
import { getIamServiceToken } from '../iam/service-token'

const MEMORY_TYPE = 'RUN_OUTCOME'
const RUNTIME_MEMORY_BASE = '/api/v1/memory'

/**
 * mutationTypes that signal the run needed intervention or hit a wall — the
 * part of a run worth carrying into the next one. Mapped to human labels for
 * the summary. (Values mirror the mutationType strings written across the
 * workflow runtime: NODE_RETRY, NODE_RESTARTED, *_BLOCKED, etc.)
 */
const FRICTION_LABELS: Record<string, string> = {
  NODE_RETRY: 'retry',
  NODE_RESTARTED: 'send-back',
  NODE_SOFT_BLOCKED: 'soft-block',
  EVAL_GATE_BLOCKED: 'eval-gate block',
  VERIFIER_BLOCKED: 'verifier block',
  POLICY_CHECK_BLOCKED: 'policy block',
  GIT_PUSH_BLOCKED: 'git-push block',
  NODE_MANUAL_COMPLETION: 'manual completion',
  COMPENSATION_STARTED: 'compensation',
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Auth for the cross-service write — same pattern as lib/snapshot: pinned
 *  operator token if set, else the auto-minted IAM service token. */
async function authHeader(): Promise<string | undefined> {
  if (config.WORKGRAPH_SNAPSHOT_TOKEN) return `Bearer ${config.WORKGRAPH_SNAPSHOT_TOKEN}`
  const tok = await getIamServiceToken()
  return tok ? `Bearer ${tok}` : undefined
}

async function runtimePost(path: string, body: unknown): Promise<{ id?: string } | null> {
  const authorization = await authHeader()
  if (!authorization) {
    console.warn('[learning] no service token — skipping run-learning write')
    return null
  }
  const res = await fetch(`${config.AGENT_RUNTIME_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify(body),
    // Bounded: this runs fire-and-forget off the run's terminal event; a hung
    // agent-runtime must not pin a socket indefinitely.
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    console.warn(`[learning] POST ${path} → ${res.status}`)
    return null
  }
  // agent-runtime wraps as { success, data, error, requestId }.
  const json = (await res.json().catch(() => null)) as { data?: { id?: string } } | null
  return json?.data ?? null
}

type NodeRow = { label: string; status: string }
type MutationRow = { mutationType: string }
type ConsumableRow = { name: string; status: string }

/**
 * Build a compact, deterministic run-outcome summary. Same inputs → same text,
 * so re-running a workflow produces stable, diffable memory rows.
 */
export function buildRunSummary(args: {
  workflowName: string
  status: string
  nodes: NodeRow[]
  mutations: MutationRow[]
  consumables: ConsumableRow[]
}): { title: string; content: string } {
  const { workflowName, status, nodes, mutations, consumables } = args

  const total = nodes.length
  const countBy = (s: string) => nodes.filter((n) => n.status === s).length
  const completed = countBy('COMPLETED')

  const stageBits = [`${completed}/${total} completed`]
  for (const [s, word] of [
    ['FAILED', 'failed'],
    ['BLOCKED', 'blocked'],
    ['SKIPPED', 'skipped'],
  ] as const) {
    const n = countBy(s)
    if (n) stageBits.push(`${n} ${word}`)
  }

  // Stages that failed/blocked, by name — the most actionable signal.
  const stuck = nodes
    .filter((n) => n.status === 'FAILED' || n.status === 'BLOCKED')
    .map((n) => n.label)
    .slice(0, 6)

  // Friction tally across the run.
  const friction = new Map<string, number>()
  for (const m of mutations) {
    const label = FRICTION_LABELS[m.mutationType]
    if (label) friction.set(label, (friction.get(label) ?? 0) + 1)
  }
  const frictionBits = [...friction.entries()].map(([label, n]) => pluralize(n, label))

  // Artifacts produced — prefer the ones that reached a delivered state.
  const delivered = consumables.filter((c) => c.status === 'APPROVED' || c.status === 'PUBLISHED')
  const artifactNames = (delivered.length ? delivered : consumables).map((c) => c.name).slice(0, 8)

  const lines: string[] = []
  lines.push(`Last run of "${workflowName}" — ${status}.`)
  lines.push(`Stages: ${stageBits.join(', ')}.`)
  if (stuck.length) lines.push(`Stuck/failed at: ${stuck.join('; ')}.`)
  if (frictionBits.length) lines.push(`Friction: ${frictionBits.join(', ')}.`)
  lines.push(`Artifacts: ${artifactNames.length ? artifactNames.join(', ') : 'none'}.`)
  if (status !== 'COMPLETED') {
    lines.push('Carry forward: review the stuck stage(s) and friction above before re-running.')
  } else if (frictionBits.length) {
    lines.push('Carry forward: completed, but needed the interventions above — pre-empt them next time.')
  }

  const title = `Run outcome: ${workflowName} — ${status}${stuck.length ? ` (stuck: ${stuck[0]})` : ''}`
  return { title: title.slice(0, 160), content: lines.join(' ').slice(0, 1200) }
}

/**
 * Gather the run outcome and write ONE capability memory row. Resolves the
 * capability via the instance's template (Workflow.capabilityId); a run with no
 * capability (e.g. an ad-hoc template) is skipped — capability memory must be
 * anchored to a capability to be read back.
 */
export async function recordRunLearning(instanceId: string, terminalStatus: string): Promise<void> {
  try {
    const instance = await prisma.workflowInstance.findUnique({
      where: { id: instanceId },
      select: {
        name: true,
        templateId: true,
        nodes: { select: { label: true, status: true } },
        mutations: { select: { mutationType: true } },
        consumables: { select: { name: true, status: true } },
      },
    })
    if (!instance?.templateId) return

    const workflow = await prisma.workflow.findUnique({
      where: { id: instance.templateId },
      select: { capabilityId: true, name: true },
    })
    const capabilityId = workflow?.capabilityId
    if (!capabilityId) return // nothing to anchor capability memory to

    const { title, content } = buildRunSummary({
      workflowName: workflow?.name ?? instance.name,
      status: terminalStatus,
      nodes: instance.nodes,
      mutations: instance.mutations,
      consumables: instance.consumables,
    })

    // Stage 1 — staging memory tied to this execution.
    const exec = await runtimePost(`${RUNTIME_MEMORY_BASE}/execution`, {
      workflowExecutionId: instanceId,
      capabilityId,
      memoryType: MEMORY_TYPE,
      title,
      content,
      confidence: 0.6,
    })
    if (!exec?.id) return

    // Stage 2 — promote to a CAPABILITY-scoped distilled memory (status ACTIVE)
    // that the composer reads into the next run.
    await runtimePost(`${RUNTIME_MEMORY_BASE}/distilled/promote`, {
      sourceMemoryIds: [exec.id],
      scopeType: 'CAPABILITY',
      scopeId: capabilityId,
      memoryType: MEMORY_TYPE,
      title,
      content,
      confidence: 0.6,
    })
  } catch (err) {
    // Fire-and-forget: a learning-write failure must never affect the run.
    console.warn(`[learning] recordRunLearning(${instanceId}) failed:`, (err as Error).message)
  }
}
