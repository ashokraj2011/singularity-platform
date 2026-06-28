import { createHash } from 'node:crypto'

/**
 * Dual-persistence evidence pack — verify side (pure + unit-tested).
 *
 * Evidence/artifacts live in BOTH the DB (source of truth) and the work-item git
 * branch (tamper-evident mirror), linked by content hash. A manifest (committed
 * in-branch at `.singularity/evidence/<…>/manifest.json`) lists each item with its
 * git blob sha256 and the DB-recorded sha256. The GOVERNANCE_GATE then enforces:
 *   - EVIDENCE_PACK_COMPLETE       — the manifest covers every required item
 *   - EVIDENCE_DB_GIT_CONSISTENT   — every item's git hash == its DB hash
 *
 * The actual materialization (writing the pack to the branch via mcp-server) is a
 * cross-service step; this module is the data model + the verification it enables.
 */

export interface EvidenceItem {
  /** logical key, e.g. "design_document" / "test_report" / a controlKey. */
  key: string
  /** in-branch path, e.g. ".singularity/evidence/WI-1/artifacts/design_document.md". */
  path: string
  /** DB row id (consumable/artifact/receipt) this mirrors. */
  dbId?: string
  /** sha256 of the git blob (the committed content). */
  gitSha256: string
  /** sha256 the DB recorded for the same content; absent ⇒ not cross-checked. */
  dbSha256?: string
  /** object-store ref for large blobs kept out of git. */
  minioRef?: string
}

export interface EvidenceManifest {
  version: number
  items: EvidenceItem[]
}

export interface EvidencePackVerdict {
  complete: boolean
  consistent: boolean
  missing: string[]
  mismatched: string[]
}

export function computeSha256(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
}

export function buildEvidenceManifest(items: EvidenceItem[]): EvidenceManifest {
  return { version: 1, items: [...items].sort((a, b) => a.key.localeCompare(b.key)) }
}

/**
 * complete  = the manifest covers every `required` key.
 * consistent = every item that carries a DB hash has gitSha256 === dbSha256
 *              (a mismatch ⇒ the DB and the git mirror diverged = tamper/drift).
 */
export function verifyEvidencePack(
  manifest: EvidenceManifest | null | undefined,
  required: string[] = [],
): EvidencePackVerdict {
  const items = Array.isArray(manifest?.items) ? manifest!.items : []
  const byKey = new Map(items.map(i => [i.key, i]))
  const missing = required.filter(k => !byKey.has(k))
  const mismatched = items
    .filter(i => typeof i.dbSha256 === 'string' && i.dbSha256 !== i.gitSha256)
    .map(i => i.key)
  return {
    complete: missing.length === 0,
    consistent: mismatched.length === 0,
    missing,
    mismatched,
  }
}
