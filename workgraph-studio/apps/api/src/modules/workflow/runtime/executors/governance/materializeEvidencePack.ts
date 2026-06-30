import { Prisma, type WorkflowInstance } from '@prisma/client'
import { config } from '../../../../../config'
import { prisma } from '../../../../../lib/prisma'
import { computeSha256, buildEvidenceManifest, type EvidenceItem, type EvidenceManifest } from './evidencePack'

/**
 * Dual-persistence — materialize side. Writes the evidence pack into the work-item
 * git branch (the tamper-evident mirror of the DB source-of-truth) under
 * `.singularity/evidence/<workItem>/`, and returns the manifest to stamp into the
 * run/DB (context `_evidenceManifest`) so the EVIDENCE_PACK_COMPLETE /
 * EVIDENCE_DB_GIT_CONSISTENT controls can verify it.
 *
 * Cross-service I/O against the live mcp-server worktree:
 *   PUT /mcp/worktree/:code/file?path=  (writes + stages + commits per file).
 * Runtime-verified on a stack. Keep large blobs in MinIO with only a pointer here
 * (pass `minioRef` + a small pointer as `content` for those).
 */

export interface RawEvidence {
  key: string
  relPath: string
  content: string
  dbId?: string
  /** sha256 the DB recorded for this content; defaults to the git hash (same content). */
  dbSha256?: string
  minioRef?: string
}

async function mcpPutFile(workItemCode: string, relPath: string, content: string, message: string): Promise<void> {
  const writeBody = { content, message, authorEmail: 'governance@singularity.local', authorName: 'Singularity Governance' }
  // Route the worktree write through Context Fabric (dial-in aware: the laptop
  // writes into its LOCAL worktree, else CF falls back to the shared mcp). Fall
  // back to direct mcp HTTP here only when CF is unconfigured / unreachable / errors.
  const cfUrl = config.CONTEXT_FABRIC_URL?.replace(/\/$/, '')
  if (cfUrl) {
    try {
      const cfResp = await fetch(`${cfUrl}/api/runtime-bridge/worktree/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '' },
        body: JSON.stringify({ workItemCode, path: relPath, ...writeBody }),
      })
      if (cfResp.ok) return
      // CF reachable but errored — fall through to direct mcp HTTP.
    } catch {
      // CF unreachable — fall through to direct mcp HTTP.
    }
  }
  const base = config.MCP_SERVER_URL.replace(/\/$/, '')
  const url = `${base}/mcp/worktree/${encodeURIComponent(workItemCode)}/file?path=${encodeURIComponent(relPath)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
    body: JSON.stringify(writeBody),
  })
  if (!res.ok) throw new Error(`mcp worktree write failed (${res.status}) for ${relPath}`)
}

export async function materializeEvidencePack(workItemCode: string, items: RawEvidence[]): Promise<EvidenceManifest> {
  const baseDir = `.singularity/evidence/${workItemCode}`
  const manifestItems: EvidenceItem[] = []
  for (const it of items) {
    const gitSha256 = computeSha256(it.content)
    const path = `${baseDir}/${it.relPath}`
    await mcpPutFile(workItemCode, path, it.content, `governance: evidence ${it.key}`)
    manifestItems.push({
      key: it.key,
      path,
      dbId: it.dbId,
      gitSha256,
      dbSha256: it.dbSha256 ?? gitSha256,
      minioRef: it.minioRef,
    })
  }
  const manifest = buildEvidenceManifest(manifestItems)
  await mcpPutFile(workItemCode, `${baseDir}/manifest.json`, JSON.stringify(manifest, null, 2), 'governance: evidence manifest')
  return manifest
}

function isRec(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'item'
}

/**
 * Gather the run's APPROVED/PUBLISHED consumables (the DB source-of-truth) and
 * mirror them into the work-item git branch as an evidence pack, stamping the
 * manifest into the instance context (`_evidenceManifest`) for the EVIDENCE_PACK_*
 * controls. Returns the manifest, or null when there's no work-item branch or no
 * evidence. Cross-service I/O (mcp worktree) — runtime-verified on a stack.
 */
export async function materializeRunEvidence(instance: WorkflowInstance): Promise<EvidenceManifest | null> {
  const ctx = isRec(instance.context) ? instance.context : {}
  const workItemCode =
    typeof ctx.workItemCode === 'string' ? ctx.workItemCode
    : typeof ctx.work_item_code === 'string' ? ctx.work_item_code
    : typeof ctx.workItemId === 'string' ? ctx.workItemId
    : undefined
  if (!workItemCode) return null

  const consumables = await prisma.consumable
    .findMany({
      where: { instanceId: instance.id, status: { in: ['APPROVED', 'PUBLISHED'] } },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    })
    .catch(() => [] as Array<{ id: string; name: string; versions: Array<{ payload: unknown }> }>)

  const items: RawEvidence[] = []
  for (const c of consumables) {
    const payload = c.versions[0]?.payload
    if (payload === undefined) continue
    items.push({ key: c.name, relPath: `artifacts/${slug(c.name)}.json`, content: JSON.stringify(payload, null, 2), dbId: c.id })
  }
  if (items.length === 0) return null

  const manifest = await materializeEvidencePack(workItemCode, items)
  await prisma.workflowInstance
    .update({
      where: { id: instance.id },
      data: { context: { ...ctx, _evidenceManifest: manifest } as unknown as Prisma.InputJsonValue },
    })
    .catch(() => undefined)
  return manifest
}
