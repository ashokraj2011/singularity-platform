import { config } from '../../../../../config'
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
  const base = config.MCP_SERVER_URL.replace(/\/$/, '')
  const url = `${base}/mcp/worktree/${encodeURIComponent(workItemCode)}/file?path=${encodeURIComponent(relPath)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
    body: JSON.stringify({ content, message, authorEmail: 'governance@singularity.local', authorName: 'Singularity Governance' }),
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
