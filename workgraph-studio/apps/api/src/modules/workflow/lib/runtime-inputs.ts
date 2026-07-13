/**
 * Runtime values required by a workflow design.
 *
 * Node configuration is intentionally JSON and evolves over time, so the
 * contract is derived by scanning placeholder references instead of keeping a
 * second hand-maintained list in the editor. Only values that can be captured
 * before the run starts are returned as launch inputs; output/event/context
 * references remain runtime references and are shown for transparency.
 */

export type RuntimeInputScope = 'vars' | 'globals' | 'params'
export type RuntimeReferenceScope = RuntimeInputScope | 'event' | 'output' | 'context' | 'workItem'
export type RuntimeInputKind = 'text' | 'number' | 'boolean' | 'json' | 'user' | 'team' | 'role' | 'skill'

export type RuntimeInputNodeUse = {
  nodeId: string
  nodeLabel: string
  nodeType: string
  field: string
}

export type RuntimeInputRequirement = {
  id: string
  key: string
  scope: RuntimeInputScope
  reference: string
  label: string
  description?: string
  type?: string
  kind: RuntimeInputKind
  required: boolean
  defaultValue?: unknown
  nodes: RuntimeInputNodeUse[]
}

export type RuntimeReference = Omit<RuntimeInputRequirement, 'scope'> & {
  scope: RuntimeReferenceScope
  runtimeOnly: boolean
  runtimeScope: RuntimeReferenceScope
}

type NodeLike = {
  id: string
  label?: string | null
  nodeType?: unknown
  config?: unknown
}

type VariableLike = {
  key: string
  label?: string
  type?: string
  defaultValue?: unknown
  description?: string
  scope?: string
}

const PLACEHOLDER_RE = /{{\s*([^{}]+?)\s*}}/g
const VALID_SCOPES = new Set<RuntimeReferenceScope>(['vars', 'globals', 'params', 'event', 'output', 'context', 'workItem'])

function humanize(value: string): string {
  return value
    .split(/[._-]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeReference(raw: string): { scope: RuntimeReferenceScope; key: string; reference: string } | null {
  let value = raw.trim().replace(/^instance\./, '').replace(/^runtime\./, '')
  const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/)
  if (!match) return null
  const scope = match[1] as RuntimeReferenceScope
  const key = match[2].trim()
  if (!VALID_SCOPES.has(scope) || !key || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return null
  return { scope, key, reference: `${scope}.${key}` }
}

function inferKind(field: string, nodeType: string): RuntimeInputKind {
  const lower = `${field} ${nodeType}`.toLowerCase()
  if (/(assignedto|assignee|reviewer|approver|user(id)?)/.test(lower)) return 'user'
  if (/(team(id)?|group(id)?)/.test(lower)) return 'team'
  if (/(role(key)?)/.test(lower)) return 'role'
  if (/(skill(key)?)/.test(lower)) return 'skill'
  if (/(count|number|limit|timeout|hours|minutes)/.test(lower)) return 'number'
  if (/(enabled|required|allow|approve|active|flag)/.test(lower)) return 'boolean'
  return 'text'
}

function mergeKind(existing: RuntimeInputKind, next: RuntimeInputKind): RuntimeInputKind {
  return existing === next ? existing : 'text'
}

/** Collect every placeholder use, preserving node ownership for the launch UI. */
export function collectRuntimeInputRequirements(
  nodes: NodeLike[],
  variableDefs: VariableLike[] = [],
): { inputs: RuntimeInputRequirement[]; references: RuntimeReference[] } {
  const byId = new Map<string, RuntimeReference>()

  const add = (args: {
    scope: RuntimeReferenceScope
    key: string
    reference: string
    node?: NodeLike
    field?: string
    label?: string
    description?: string
    type?: string
    defaultValue?: unknown
    required?: boolean
    kind?: RuntimeInputKind
    runtimeOnly?: boolean
  }) => {
    const id = `${args.scope}.${args.key}`
    const nodeUse = args.node
      ? {
          nodeId: args.node.id,
          nodeLabel: args.node.label?.trim() || args.node.id,
          nodeType: String(args.node.nodeType ?? 'UNKNOWN'),
          field: args.field ?? 'configuration',
        }
      : undefined
    const previous = byId.get(id)
    if (previous) {
      if (nodeUse && !previous.nodes.some(use => use.nodeId === nodeUse.nodeId && use.field === nodeUse.field)) {
        previous.nodes.push(nodeUse)
      }
      previous.required = previous.required || (Boolean(args.required) && previous.defaultValue === undefined && args.defaultValue === undefined)
      previous.kind = mergeKind(previous.kind, args.kind ?? 'text')
      if (previous.defaultValue === undefined && args.defaultValue !== undefined) previous.defaultValue = args.defaultValue
      if (!previous.description && args.description) previous.description = args.description
      return
    }
    byId.set(id, {
      id,
      key: args.key,
      scope: args.scope,
      reference: args.reference,
      label: args.label ?? humanize(args.key),
      description: args.description,
      type: args.type,
      kind: args.kind ?? 'text',
      required: Boolean(args.required),
      ...(args.defaultValue !== undefined ? { defaultValue: args.defaultValue } : {}),
      nodes: nodeUse ? [nodeUse] : [],
      runtimeOnly: Boolean(args.runtimeOnly),
      runtimeScope: args.scope,
    })
  }

  for (const def of variableDefs) {
    if (!def.key || String(def.scope ?? 'INPUT').toUpperCase() === 'CONSTANT') continue
    const type = String(def.type ?? 'STRING').toUpperCase()
    add({
      scope: 'vars',
      key: def.key,
      reference: `vars.${def.key}`,
      label: def.label ?? humanize(def.key),
      description: def.description,
      type,
      defaultValue: def.defaultValue,
      required: def.defaultValue === undefined,
      kind: type === 'NUMBER' ? 'number' : type === 'BOOLEAN' ? 'boolean' : type === 'JSON' ? 'json' : 'text',
    })
  }

  const visit = (value: unknown, node: NodeLike, path: string): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER_RE)) {
        const normalized = normalizeReference(match[1])
        if (!normalized) continue
        const runtimeOnly = !['vars', 'globals', 'params'].includes(normalized.scope)
        add({
          ...normalized,
          node,
          field: path || 'configuration',
          kind: runtimeOnly ? 'text' : inferKind(path, String(node.nodeType ?? 'UNKNOWN')),
          runtimeOnly,
          required: !runtimeOnly,
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, node, `${path}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([key, item]) => visit(item, node, path ? `${path}.${key}` : key))
    }
  }

  for (const node of nodes) visit(node.config, node, '')

  const references = [...byId.values()]
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key))
  const inputs = references
    .filter(reference => !reference.runtimeOnly && (reference.scope === 'vars' || reference.scope === 'globals' || reference.scope === 'params'))
    .map(reference => {
      const { runtimeOnly: _runtimeOnly, runtimeScope: _runtimeScope, ...input } = reference
      return input as RuntimeInputRequirement
    })
  return {
    inputs,
    references,
  }
}

export function missingRuntimeInputs(
  inputs: RuntimeInputRequirement[],
  values: { vars?: Record<string, unknown>; globals?: Record<string, unknown>; params?: Record<string, unknown> },
): RuntimeInputRequirement[] {
  return inputs.filter(input => {
    if (!input.required || input.defaultValue !== undefined) return false
    const bucket = values[input.scope] ?? {}
    const value = bucket[input.key]
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  })
}
