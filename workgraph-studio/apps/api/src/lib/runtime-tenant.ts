type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringKey(source: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(source)) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function resolveRuntimeTenantId(options: {
  nodeConfig?: unknown
  instanceContext?: unknown
}): string | undefined {
  const nodeConfig = isRecord(options.nodeConfig) ? options.nodeConfig : {}
  const standard = isRecord(nodeConfig.standard) ? nodeConfig.standard : {}
  const context = isRecord(options.instanceContext) ? options.instanceContext : {}
  const vars = isRecord(context._vars) ? context._vars : isRecord(context.vars) ? context.vars : {}
  const globals = isRecord(context._globals) ? context._globals : isRecord(context.globals) ? context.globals : {}
  const workItem = isRecord(context._workItem) ? context._workItem : {}
  const workItemInput = isRecord(workItem.input) ? workItem.input : {}

  return stringKey(nodeConfig, 'tenantId', 'tenant_id')
    ?? stringKey(standard, 'tenantId', 'tenant_id')
    ?? stringKey(context, 'tenantId', 'tenant_id')
    ?? stringKey(vars, 'tenantId', 'tenant_id')
    ?? stringKey(globals, 'tenantId', 'tenant_id')
    ?? stringKey(workItem, 'tenantId', 'tenant_id')
    ?? stringKey(workItemInput, 'tenantId', 'tenant_id')
}

export function runtimeTenantRequired(mode: string | undefined): boolean {
  return (mode ?? '').trim().toLowerCase() === 'strict'
}
