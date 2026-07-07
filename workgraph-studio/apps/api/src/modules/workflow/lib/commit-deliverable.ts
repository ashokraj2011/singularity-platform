import { prisma } from '../../../lib/prisma'
import { logEvent } from '../../../lib/audit'
import { buildAdapter } from '../../connectors/connector.service'

type JsonObject = Record<string, unknown>
const isRecord = (v: unknown): v is JsonObject => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const asObject = (v: unknown): JsonObject => (isRecord(v) ? v : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

// Parse owner/repo from a github URL (best-effort; mirrors the connectors router).
function parseOwnerRepo(url: string): { owner?: string; repo?: string } {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : {}
}

// Filesystem-safe slug for a deliverable path segment / filename.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document'
}

/**
 * S2 — commit a single finalized deliverable (an APPROVED/PUBLISHED consumable) to
 * the run's work branch `wi/<workCode>`, CLOUD-SIDE via the GitHub connector's
 * commitFiles op (which creates the branch from base if it doesn't exist yet).
 *
 * This is the runtime-INDEPENDENT path: it puts each phase's documents on the work
 * branch as they're finalized, without the laptop bridge — which is also what gives
 * the RAISE_PR node / GIT_PUSH "open PR" flag a branch to open a PR against.
 *
 * Best-effort + intended to be fire-and-forget (call with `.catch`): a git hiccup
 * must NEVER break the approve/publish transition. Any missing precondition
 * (no work-item code, no content, no GIT connector) → silently no-op; the runtime
 * working-tree push (S3) may still carry the artifact.
 */
export async function commitDeliverableConsumable(consumableId: string): Promise<void> {
  const consumable = await prisma.consumable.findUnique({
    where: { id: consumableId },
    include: { instance: true },
  })
  if (!consumable || !consumable.instance) return

  const content = str(asObject(consumable.formData).content)
  if (!content) return // not a document-bearing consumable — nothing to commit

  const ctx = asObject(consumable.instance.context)
  const vars = asObject(ctx._vars)
  const globals = asObject(ctx._globals)
  const workCode = str(vars.workCode) ?? str(vars.workItemCode)
  if (!workCode) return // no work-item code → no wi/<code> branch to target

  const repoUrl = str(vars.repoUrl) ?? str(vars.sourceUri) ?? str(globals.repoUrl)
  const base = str(globals.sourceRef) ?? 'main'
  const branch = `wi/${workCode}`
  const role = str(consumable.roleKey) ?? str(consumable.skillKey) ?? 'agent'
  const path = `deliverables/${workCode}/${slug(role)}/${slug(consumable.name)}.md`

  const connector = await prisma.connector.findFirst({
    where: { type: 'GIT', archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!connector) return // no cloud git configured — leave it to the runtime push path

  const parsed = repoUrl ? parseOwnerRepo(repoUrl) : {}
  const adapter = buildAdapter(connector.type, connector.config as JsonObject, connector.credentials as JsonObject)
  const result = (await adapter.invoke('commitFiles', {
    branch,
    base,
    message: `${role}: ${consumable.name} [${consumable.status}]`,
    ...(parsed.owner ? { owner: parsed.owner } : {}),
    ...(parsed.repo ? { repo: parsed.repo } : {}),
    files: [{ path, content }],
  })) as { committed?: boolean; commitSha?: string; created?: boolean }

  await logEvent('DeliverableCommitted', 'Consumable', consumableId, undefined, {
    instanceId: consumable.instanceId,
    branch,
    path,
    commitSha: result?.commitSha,
    branchCreated: result?.created,
  })
}
