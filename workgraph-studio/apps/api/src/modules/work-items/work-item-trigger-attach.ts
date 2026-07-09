import type { WorkItem } from '@prisma/client'
import { prisma } from '../../lib/prisma'

const OPEN_WORK_ITEM_STATUSES = ['SCHEDULED', 'QUEUED', 'IN_PROGRESS', 'AWAITING_PARENT_APPROVAL'] as const

export type TriggerDocument = {
  label: string
  url?: string
  content?: string
  excerpt?: string
  mediaType?: string
  source?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function triggerStringAt(root: Record<string, unknown>, rawPath: unknown): string | undefined {
  const value = triggerValueAt(root, rawPath)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function triggerValueAt(root: Record<string, unknown>, rawPath: unknown): unknown {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined
  const path = rawPath.replace(/^\$\.?/, '').trim()
  return path.split('.').filter(Boolean).reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function normalizeTriggerDocument(value: unknown, index: number, source: string): TriggerDocument | null {
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    const isUrl = /^https?:\/\//i.test(text)
    return {
      label: `${source} document ${index + 1}`,
      ...(isUrl ? { url: text } : { content: text.slice(0, 24_000) }),
      excerpt: text.slice(0, 3_000),
      mediaType: isUrl ? 'text/uri-list' : 'text/plain',
      source,
    }
  }
  if (!isRecord(value)) return null
  const label = [value.label, value.title, value.name, `document ${index + 1}`]
    .find(item => typeof item === 'string' && item.trim())
  const url = [value.url, value.href, value.link, value.sourceRef]
    .find(item => typeof item === 'string' && item.trim())
  const content = [value.content, value.text, value.body, value.markdown]
    .find(item => typeof item === 'string' && item.trim())
  const excerpt = [value.excerpt, value.summary]
    .find(item => typeof item === 'string' && item.trim())
  if (!url && !content && !excerpt) return null
  return {
    label: String(label),
    ...(typeof url === 'string' ? { url: url.trim() } : {}),
    ...(typeof content === 'string' ? { content: content.trim().slice(0, 24_000) } : {}),
    ...(typeof excerpt === 'string' ? { excerpt: excerpt.trim().slice(0, 3_000) } : {}),
    mediaType: typeof value.mediaType === 'string' ? value.mediaType : typeof value.mimeType === 'string' ? value.mimeType : undefined,
    source,
  }
}

function normalizeTriggerDocuments(value: unknown, source: string): TriggerDocument[] {
  if (value == null) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw
    .map((item, index) => normalizeTriggerDocument(item, index, source))
    .filter((item): item is TriggerDocument => Boolean(item))
}

export function triggerDocumentsFromPayload(args: {
  payload: Record<string, unknown>
  payloadMapping: unknown
}): TriggerDocument[] {
  const mapping = isRecord(args.payloadMapping) ? args.payloadMapping : {}
  const sources: Array<{ value: unknown; source: string }> = []
  for (const key of ['documentsPath', 'documentLinksPath', 'documentUrlsPath', 'documentUrlPath', 'documentPath']) {
    const value = triggerValueAt(args.payload, mapping[key])
    if (value !== undefined) sources.push({ value, source: String(mapping[key]) })
  }
  for (const key of ['documents', 'documentLinks', 'documentUrls', 'documentUrl', 'document']) {
    if (args.payload[key] !== undefined) sources.push({ value: args.payload[key], source: key })
  }
  const seen = new Set<string>()
  return sources.flatMap(source => normalizeTriggerDocuments(source.value, source.source))
    .filter(doc => {
      const key = `${doc.label}|${doc.url ?? ''}|${doc.content ?? ''}|${doc.excerpt ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)
}

export function resolveTriggerCorrelationKey(args: {
  payload: Record<string, unknown>
  payloadMapping: unknown
  dedupeKey?: string | null
}): string | undefined {
  const mapping = isRecord(args.payloadMapping) ? args.payloadMapping : {}
  const path = mapping.correlationKeyPath ?? mapping.dedupeKeyPath
  return triggerStringAt(args.payload, path)
    ?? (typeof mapping.correlationKey === 'string' && mapping.correlationKey.trim() ? mapping.correlationKey.trim() : undefined)
    ?? (typeof args.dedupeKey === 'string' && args.dedupeKey.trim() ? args.dedupeKey.trim() : undefined)
}

export async function findAttachableWorkItemForTrigger(args: {
  payload: Record<string, unknown>
  payloadMapping: unknown
  dedupeKey?: string | null
  capabilityId?: string | null
}): Promise<{ workItem: WorkItem; matchedBy: string; correlationKey?: string } | null> {
  const mapping = isRecord(args.payloadMapping) ? args.payloadMapping : {}
  const capabilityWhere = args.capabilityId ? { parentCapabilityId: args.capabilityId } : {}
  const workItemId = triggerStringAt(args.payload, mapping.workItemIdPath)
  if (workItemId) {
    const workItem = await prisma.workItem.findFirst({
      where: { id: workItemId, status: { in: [...OPEN_WORK_ITEM_STATUSES] }, ...capabilityWhere },
    })
    if (workItem) return { workItem, matchedBy: 'workItemId' }
  }

  const workCode = triggerStringAt(args.payload, mapping.workCodePath)
  if (workCode) {
    const workItem = await prisma.workItem.findFirst({
      where: { workCode, status: { in: [...OPEN_WORK_ITEM_STATUSES] }, ...capabilityWhere },
    })
    if (workItem) return { workItem, matchedBy: 'workCode' }
  }

  const correlationKey = resolveTriggerCorrelationKey(args)
  if (correlationKey) {
    const workItem = await prisma.workItem.findFirst({
      where: {
        status: { in: [...OPEN_WORK_ITEM_STATUSES] },
        ...capabilityWhere,
        OR: [
          { input: { path: ['triggerCorrelationKey'], equals: correlationKey } },
          { input: { path: ['externalCorrelationKey'], equals: correlationKey } },
          { details: { path: ['triggerCorrelationKey'], equals: correlationKey } },
          { details: { path: ['externalCorrelationKey'], equals: correlationKey } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    })
    if (workItem) return { workItem, matchedBy: 'correlationKey', correlationKey }
  }

  return null
}

// ── P1-7 inbound-event idempotency ──────────────────────────────────────────
// Window (ms) after which a claim for the same (trigger, dedupeValue) is treated
// as stale, so a genuine later recurrence of the same key is allowed through
// instead of being suppressed forever. Env-overridable; floor 60s.
const DEDUP_WINDOW_MS = Math.max(60_000, Number(process.env.WORKITEM_EVENT_DEDUP_WINDOW_MS ?? 15 * 60_000))

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002')
}

export type TriggerEventClaim =
  | { status: 'claimed' }
  | { status: 'duplicate'; workItemId: string | null }

// Race-safe idempotency claim for an inbound trigger event. Call it ONLY when no
// existing open WorkItem was attachable (findAttachableWorkItemForTrigger returned
// null) — i.e. right before creating a new WorkItem.
//   'claimed'   → first delivery; create + route the WorkItem, then call
//                 recordTriggerEventWorkItem(...).
//   'duplicate' → a concurrent or retried delivery within the window already owns
//                 this event; the caller MUST NOT create another WorkItem (which
//                 would double-start a run under AUTO_START).
// With no dedupeValue there is nothing to dedupe on, so it always claims (today's
// behavior). The unique index on (triggerId, dedupeValue) is the actual race guard.
export async function claimTriggerEvent(args: {
  triggerId: string
  dedupeValue: string | undefined | null
}): Promise<TriggerEventClaim> {
  const dedupeValue = typeof args.dedupeValue === 'string' && args.dedupeValue.trim() ? args.dedupeValue.trim() : undefined
  if (!args.triggerId || !dedupeValue) return { status: 'claimed' }
  const where = { triggerId_dedupeValue: { triggerId: args.triggerId, dedupeValue } }
  try {
    await prisma.workItemEventDedup.create({ data: { triggerId: args.triggerId, dedupeValue } })
    return { status: 'claimed' }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const existing = await prisma.workItemEventDedup.findUnique({ where })
    const ageMs = existing ? Date.now() - existing.claimedAt.getTime() : Number.MAX_SAFE_INTEGER
    if (existing && ageMs < DEDUP_WINDOW_MS) {
      return { status: 'duplicate', workItemId: existing.workItemId ?? null }
    }
    // Older than the window (a prior occurrence) → refresh the claim and let this
    // recurrence proceed. A tie between two post-window deliveries is acceptable.
    await prisma.workItemEventDedup.update({ where, data: { claimedAt: new Date(), workItemId: null } }).catch(() => {})
    return { status: 'claimed' }
  }
}

// Attach the created WorkItem id to its dedupe claim so a later duplicate delivery
// can return the same WorkItem instead of nothing. Best-effort.
export async function recordTriggerEventWorkItem(args: {
  triggerId: string
  dedupeValue: string | undefined | null
  workItemId: string
}): Promise<void> {
  const dedupeValue = typeof args.dedupeValue === 'string' && args.dedupeValue.trim() ? args.dedupeValue.trim() : undefined
  if (!args.triggerId || !dedupeValue) return
  await prisma.workItemEventDedup
    .update({ where: { triggerId_dedupeValue: { triggerId: args.triggerId, dedupeValue } }, data: { workItemId: args.workItemId } })
    .catch(() => {})
}
