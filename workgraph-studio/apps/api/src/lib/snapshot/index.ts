/**
 * M11.c — Execution-snapshot helpers.
 *
 * Each snapshot:
 *   1. Fetches the current upstream payload (using snapshot-token auth so
 *      the workflow runtime can call without a user JWT).
 *   2. Computes a deterministic sha256 over canonical JSON.
 *   3. Upserts into the appropriate snapshot table keyed by
 *      (externalId, sourceHash) so identical fetches dedupe but ANY change
 *      lands as a new immutable row — provenance is preserved.
 *
 * Used by AgentTaskExecutor (template snapshot, capability snapshot at run
 * start). Tool snapshots come in M11.d-ish when ToolRequestExecutor exists.
 */

import { createHash } from 'node:crypto'
import { prisma } from '../prisma'
import { config } from '../../config'
import { getAgentTemplate } from '../agent-and-tools/client'
import { proxyGet as iamProxyGet } from '../iam/client'
import { getIamServiceToken } from '../iam/service-token'

/**
 * Snapshot lookups happen at workflow runtime — there is no caller JWT, so
 * we use the auto-minted IAM service token (M11 follow-up). Operators can
 * still pin a specific token via WORKGRAPH_SNAPSHOT_TOKEN if they want a
 * narrower-scope identity for snapshot writes specifically.
 */
async function snapshotAuthHeader(): Promise<string | undefined> {
  if (config.WORKGRAPH_SNAPSHOT_TOKEN) return `Bearer ${config.WORKGRAPH_SNAPSHOT_TOKEN}`
  const tok = await getIamServiceToken()
  return tok ? `Bearer ${tok}` : undefined
}

async function snapshotAuthToken(): Promise<string | undefined> {
  if (config.WORKGRAPH_SNAPSHOT_TOKEN) return config.WORKGRAPH_SNAPSHOT_TOKEN
  return await getIamServiceToken()
}

/**
 * Stable canonical JSON: keys recursively sorted, no whitespace. Two payloads
 * with the same data produce the same hash regardless of key order.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalize(payload))
}

// ── Agent template snapshot ───────────────────────────────────────────────
//
// Returns the local Agent row id. Reuses the existing row if the upstream
// payload hasn't changed (same sourceHash); otherwise updates the row in
// place AND records the new fingerprint. The Agent table is the FK target
// of AgentRun.agentId so we can't insert N rows per template; "history"
// for Agent is recoverable from the AgentRun.startedAt + the Agent row's
// most recent fetchedAt.

export interface SnapshotAgentResult {
  agentId:       string
  fetchedFresh:  boolean   // true if we hit upstream this call (vs reuse)
  sourceHash:    string | null
}

export async function snapshotAgentTemplate(
  agentTemplateId: string,
  fetchedBy?: string,
): Promise<SnapshotAgentResult> {
  let name = `agent-template:${agentTemplateId.slice(0, 8)}`
  let description: string | undefined
  let model = 'unknown'
  let systemPrompt: string | undefined
  let sourceHash: string | null = null
  let sourceVersion: string | undefined

  try {
    const tpl = await getAgentTemplate(agentTemplateId, await snapshotAuthHeader())
    if (tpl) {
      name = tpl.name ?? name
      description = (tpl.description as string | undefined) ?? undefined
      const overrides = (tpl.modelOverrides ?? {}) as Record<string, unknown>
      model = (overrides.model as string | undefined) ?? (tpl.model as string | undefined) ?? 'unknown'
      systemPrompt = (tpl.systemPrompt as string | undefined) ?? undefined
      sourceHash = hashPayload(tpl)
      sourceVersion = (tpl.version != null ? String(tpl.version) : undefined)
    }
  } catch {
    // upstream unreachable — fall through; placeholder snapshot keeps the run unblocked
  }

  const existing = await prisma.agent.findUnique({ where: { externalTemplateId: agentTemplateId } })
  if (existing) {
    // No change → reuse and refresh fetchedAt only if hash matches (cheap).
    if (sourceHash && existing.sourceHash === sourceHash) {
      await prisma.agent.update({
        where: { id: existing.id },
        data:  { externalSyncedAt: new Date() },
      })
      return { agentId: existing.id, fetchedFresh: true, sourceHash }
    }
    // Upstream changed (or hash unknown) → update snapshot in place.
    await prisma.agent.update({
      where: { id: existing.id },
      data: {
        name,
        description,
        model,
        systemPrompt,
        externalSyncedAt: new Date(),
        sourceHash,
        sourceVersion,
        fetchedBy: fetchedBy ?? null,
      },
    })
    return { agentId: existing.id, fetchedFresh: true, sourceHash }
  }

  const created = await prisma.agent.create({
    data: {
      name,
      description,
      provider: 'agent-and-tools',
      model,
      systemPrompt,
      externalTemplateId: agentTemplateId,
      externalSyncedAt: new Date(),
      sourceHash,
      sourceVersion,
      fetchedBy: fetchedBy ?? null,
    },
  })
  return { agentId: created.id, fetchedFresh: true, sourceHash }
}

// ── Capability snapshot (read-only audit) ──────────────────────────────────
//
// Capability snapshots are pure audit: every execute that references a
// capability writes (or dedupes) one row in capability_snapshots. Workflow
// runs JOIN by externalId at read time.

export interface SnapshotCapabilityResult {
  snapshotId:   string | null   // null if upstream unreachable + no prior snapshot
  fetched:      boolean
  sourceHash:   string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function fetchCapability(id: string): Promise<Record<string, unknown> | null> {
  const tok = await snapshotAuthToken()
  // IAM /capabilities/:id keys by SLUG. If `id` looks like a UUID, fall back
  // to list+find. Same shape as the resolver does — reused logic.
  if (UUID_RE.test(id)) {
    const list = await iamProxyGet('/capabilities', { size: 500 }, tok) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | null
    const items = Array.isArray(list) ? list : (list?.items ?? [])
    return items.find((r) => String(r.id ?? '') === id) ?? null
  }
  return await iamProxyGet(`/capabilities/${encodeURIComponent(id)}`, {}, tok) as Record<string, unknown> | null
}

export async function snapshotCapability(
  externalId: string,
  fetchedBy?: string,
): Promise<SnapshotCapabilityResult> {
  let payload: Record<string, unknown> | null = null
  try {
    payload = await fetchCapability(externalId)
  } catch {
    payload = null
  }
  if (!payload) {
    // Best-effort: if no upstream + no prior snapshot exists, return null.
    const last = await prisma.capabilitySnapshot.findFirst({
      where: { externalId },
      orderBy: { fetchedAt: 'desc' },
    })
    return { snapshotId: last?.id ?? null, fetched: false, sourceHash: last?.sourceHash ?? null }
  }
  const sourceHash = hashPayload(payload)
  // Dedupe by (externalId, sourceHash). If the row already exists this is a no-op.
  const upserted = await prisma.capabilitySnapshot.upsert({
    where:  { externalId_sourceHash: { externalId, sourceHash } },
    create: {
      externalId,
      capabilityKey: (payload.capability_id as string | undefined) ?? null,
      name:          (payload.name as string | undefined) ?? null,
      capabilityType: (payload.capability_type as string | undefined) ?? null,
      payload:       payload as object,
      sourceHash,
      sourceVersion: null,
      fetchedBy:     fetchedBy ?? null,
    },
    update: {},                                   // immutable on hash
  })
  return { snapshotId: upserted.id, fetched: true, sourceHash }
}
