/**
 * Shared blueprint-workbench launch-URL builder.
 *
 * Extracted from RunViewerPage so the graph view (RunGraphView) can open the cockpit too
 * without importing back from RunViewerPage (which imports RunGraphView → cycle). Builds the
 * `/workbench/?workflowInstanceId=…&workflowNodeId=…&goal=…&loopDefinition=<base64>…` URL the
 * cockpit parses in readWorkflowDefaults(). `{{…}}` template vars in a node's workbench config
 * are rendered against the run context before encoding.
 */
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

const BLUEPRINT_WORKBENCH_URL = viteEnv.VITE_BLUEPRINT_WORKBENCH_URL
  // M100 P3 — same-origin under the edge gateway (was :5176).
  ?? '/workbench/'

export function blueprintWorkbenchOrigin() {
  if (typeof window === 'undefined') return ''
  return new URL(BLUEPRINT_WORKBENCH_URL, window.location.href).origin
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function buildWorkbenchLaunchUrl(
  workflowInstanceId: string,
  workflowNodeId: string,
  config: Record<string, unknown>,
  uiMode: 'neo',
  runtimeContext: Record<string, unknown> = {},
) {
  const url = new URL(BLUEPRINT_WORKBENCH_URL, window.location.href)
  const renderedConfig = renderWorkbenchConfig(config, runtimeContext)
  const bindings = asRecord(renderedConfig.agentBindings)
  url.searchParams.set('workflowInstanceId', workflowInstanceId)
  url.searchParams.set('workflowNodeId', workflowNodeId)
  url.searchParams.set('ui', uiMode)
  const phaseId = cleanLaunchString(renderedConfig.phaseId)
  const goal = cleanLaunchString(renderedConfig.goal) || cleanLaunchString(renderedConfig.task)
  const sourceUri = cleanLaunchString(renderedConfig.sourceUri)
  const sourceRef = cleanLaunchString(renderedConfig.sourceRef)
  const capabilityId = cleanLaunchString(renderedConfig.capabilityId)
  if (phaseId) url.searchParams.set('phaseId', phaseId)
  if (goal) url.searchParams.set('goal', goal)
  if (renderedConfig.sourceType === 'github' || renderedConfig.sourceType === 'localdir') url.searchParams.set('sourceType', renderedConfig.sourceType)
  if (sourceUri) url.searchParams.set('sourceUri', sourceUri)
  if (sourceRef) url.searchParams.set('sourceRef', sourceRef)
  if (capabilityId) url.searchParams.set('capabilityId', capabilityId)
  setCleanParam(url, 'architectAgentTemplateId', bindings.architectAgentTemplateId)
  setCleanParam(url, 'developerAgentTemplateId', bindings.developerAgentTemplateId)
  setCleanParam(url, 'qaAgentTemplateId', bindings.qaAgentTemplateId)
  setCleanParam(url, 'productOwnerAgentTemplateId', bindings.productOwnerAgentTemplateId)
  setCleanParam(url, 'securityAgentTemplateId', bindings.securityAgentTemplateId)
  setCleanParam(url, 'devopsAgentTemplateId', bindings.devopsAgentTemplateId)
  if (renderedConfig.gateMode === 'auto' || renderedConfig.gateMode === 'manual') url.searchParams.set('gateMode', renderedConfig.gateMode)
  if (renderedConfig.loopDefinition && typeof window !== 'undefined') {
    try {
      url.searchParams.set('loopDefinition', window.btoa(JSON.stringify(renderedConfig.loopDefinition)))
    } catch {
      // Keep run approval usable if a malformed Workbench config sneaks in.
    }
  }
  return url.toString()
}

function setCleanParam(url: URL, key: string, value: unknown) {
  const text = cleanLaunchString(value)
  if (text) url.searchParams.set(key, text)
}

function cleanLaunchString(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || /\{\{[^}]+}}/.test(text)) return ''
  return text
}

function renderWorkbenchConfig(config: Record<string, unknown>, runtimeContext: Record<string, unknown>): Record<string, unknown> {
  return renderWorkbenchValue(config, {
    context: runtimeContext,
    instance: {
      vars: asRecord(runtimeContext._vars),
      globals: asRecord(runtimeContext._globals),
      params: asRecord(runtimeContext._params),
    },
    vars: asRecord(runtimeContext._vars),
    globals: asRecord(runtimeContext._globals),
    params: asRecord(runtimeContext._params),
  }) as Record<string, unknown>
}

function renderWorkbenchValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderWorkbenchTemplate(value, context)
  if (Array.isArray(value)) return value.map(item => renderWorkbenchValue(item, context))
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, renderWorkbenchValue(child, context)]))
  }
  return value
}

function renderWorkbenchTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = lookupWorkbenchPath(context, rawPath.trim())
    return value === undefined || value === null ? '' : String(value)
  })
}

function lookupWorkbenchPath(root: Record<string, unknown>, path: string): unknown {
  const direct = root[path]
  if (direct !== undefined) return direct
  return path.split('.').reduce<unknown>((cursor, segment) => {
    const object = cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor as Record<string, unknown> : null
    return object ? object[segment] : undefined
  }, root)
}
