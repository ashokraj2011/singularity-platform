import { config } from '../../../../config'
import { redactSecrets } from '../../../../lib/redact'

type GrantRequest = {
  toolName: string
  args: Record<string, unknown>
  runContext: Record<string, unknown>
  workflowPolicy?: Record<string, unknown>
}

type GrantResponse = {
  grant?: unknown
  grantEnabled?: boolean
  error?: unknown
  detail?: unknown
}

export function mcpToolGrantMode(): 'off' | 'grace' | 'enforce' {
  return config.MCP_TOOL_GRANT_MODE
}

export async function requestOperationalMcpToolGrant(request: GrantRequest): Promise<unknown | undefined> {
  const mode = mcpToolGrantMode()
  if (mode === 'off') return undefined

  let response: Response
  try {
    response = await fetch(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/internal/mcp/tool-grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '',
      },
      body: JSON.stringify({
        toolName: request.toolName,
        args: request.args,
        runContext: request.runContext,
        workflowPolicy: request.workflowPolicy ?? {},
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    if (mode === 'enforce') {
      throw new Error(`Context Fabric tool-grant request failed: ${redactSecrets((err as Error).message)}`)
    }
    return undefined
  }

  const text = await response.text()
  let body: GrantResponse = {}
  try {
    body = text ? JSON.parse(text) as GrantResponse : {}
  } catch {
    body = { error: text }
  }

  if (!response.ok) {
    const detail = typeof body.detail === 'string'
      ? body.detail
      : typeof body.error === 'string'
        ? body.error
        : text || `HTTP ${response.status}`
    if (mode === 'enforce') {
      throw new Error(`Context Fabric refused MCP tool grant for ${request.toolName}: ${redactSecrets(detail)}`)
    }
    return undefined
  }

  if (body.grant) return body.grant
  if (mode === 'enforce') {
    throw new Error(`Context Fabric returned no MCP tool grant for ${request.toolName} while MCP_TOOL_GRANT_MODE=enforce`)
  }
  return undefined
}
