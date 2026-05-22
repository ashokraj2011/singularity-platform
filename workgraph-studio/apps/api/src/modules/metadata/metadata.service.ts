import type {
  MetadataDefinition,
  MetadataDefinitionKind,
  MetadataScopeType,
  Prisma,
} from '@prisma/client'
import { prisma } from '../../lib/prisma'

export type MetadataSnapshot = {
  id: string
  kind: MetadataDefinitionKind
  key: string
  version: number
  scopeType: MetadataScopeType
  scopeId: string
  label: string
  description?: string | null
  icon?: string | null
  color?: string | null
  category?: string | null
  schema: Prisma.JsonValue
  defaults: Prisma.JsonValue
  policy: Prisma.JsonValue
  ui: Prisma.JsonValue
  compatibility: Prisma.JsonValue
}

export function normalizeMetadataKey(value: unknown, fallback = 'GENERAL'): string {
  const raw = String(value ?? fallback).trim()
  if (!raw) return fallback
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback
}

export function snapshotMetadataDefinition(def: MetadataDefinition): MetadataSnapshot {
  return {
    id: def.id,
    kind: def.kind,
    key: def.key,
    version: def.version,
    scopeType: def.scopeType,
    scopeId: def.scopeId,
    label: def.label,
    description: def.description,
    icon: def.icon,
    color: def.color,
    category: def.category,
    schema: def.schema,
    defaults: def.defaults,
    policy: def.policy,
    ui: def.ui,
    compatibility: def.compatibility,
  }
}

export async function resolveMetadataDefinition(args: {
  kind: MetadataDefinitionKind
  key?: string | null
  capabilityId?: string | null
  workflowId?: string | null
  nodeId?: string | null
}): Promise<MetadataDefinition | null> {
  const key = normalizeMetadataKey(args.key)
  const scoped: Array<{ scopeType: MetadataScopeType; scopeId: string }> = []
  if (args.nodeId) scoped.push({ scopeType: 'NODE', scopeId: args.nodeId })
  if (args.workflowId) scoped.push({ scopeType: 'WORKFLOW', scopeId: args.workflowId })
  if (args.capabilityId) scoped.push({ scopeType: 'CAPABILITY', scopeId: args.capabilityId })
  scoped.push({ scopeType: 'GLOBAL', scopeId: '*' })

  for (const scope of scoped) {
    const def = await prisma.metadataDefinition.findFirst({
      where: {
        kind: args.kind,
        key,
        status: 'ACTIVE',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      },
      orderBy: { version: 'desc' },
    })
    if (def) return def
  }
  return null
}

export async function resolveMetadataSnapshot(args: {
  kind: MetadataDefinitionKind
  key?: string | null
  capabilityId?: string | null
  workflowId?: string | null
  nodeId?: string | null
}): Promise<{ key: string; version: number; snapshot: MetadataSnapshot | null }> {
  const key = normalizeMetadataKey(args.key)
  const def = await resolveMetadataDefinition({ ...args, key })
  return {
    key,
    version: def?.version ?? 1,
    snapshot: def ? snapshotMetadataDefinition(def) : null,
  }
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
