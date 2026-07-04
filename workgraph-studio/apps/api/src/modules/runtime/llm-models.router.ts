import { Router, type Router as ExpressRouter } from 'express'
import { config } from '../../config'
import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../../lib/upstream-json'

export const llmModelsRouter: ExpressRouter = Router()

type McpProxyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; body: { error: string; message: string; details?: Record<string, unknown> } }

function mcpErrorCode(path: string): string {
  if (path.includes('/workspaces/')) return 'MCP_WORKSPACE_STATS_UNAVAILABLE'
  if (path.includes('/discovery')) return 'MCP_DISCOVERY_UNAVAILABLE'
  if (path.includes('/providers')) return 'MCP_PROVIDER_CATALOG_UNAVAILABLE'
  if (path.includes('/models')) return 'MCP_MODEL_CATALOG_UNAVAILABLE'
  return 'MCP_RUNTIME_UNAVAILABLE'
}

type McpBody = UpstreamJsonBody

async function readMcpBody(res: Response): Promise<McpBody> {
  return readUpstreamJsonBody(res)
}

async function fetchMcpJson(path: string): Promise<McpProxyResult> {
  const url = `${config.MCP_SERVER_URL.replace(/\/$/, '')}${path}`
  let upstream: Response
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
    })
  } catch (err) {
    return {
      ok: false as const,
      status: 502,
      body: {
        error: 'MCP_RUNTIME_UNREACHABLE',
        message: `MCP request failed for ${path}: ${(err as Error).message}`,
        details: { path },
      },
    }
  }
  const body = await readMcpBody(upstream)
  if (!upstream.ok) {
    return {
      ok: false as const,
      status: upstream.status,
      body: {
        error: mcpErrorCode(path),
        message: upstreamSnippet(body.raw, 700) || `MCP returned ${upstream.status}`,
        details: { path },
      },
    }
  }
  if (body.parseError) {
    return {
      ok: false as const,
      status: 502,
      body: {
        error: mcpErrorCode(path),
        message: `MCP returned invalid JSON for ${path}: ${body.parseError}`,
        details: { path, body: upstreamSnippet(body.raw, 700) },
      },
    }
  }
  return { ok: true as const, body: body.data }
}

llmModelsRouter.get('/models', async (_req, res, next) => {
  try {
    const upstream = await fetchMcpJson('/llm/models')
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    res.json(upstream.body)
  } catch (err) {
    next(err)
  }
})

llmModelsRouter.get('/providers', async (_req, res, next) => {
  try {
    const upstream = await fetchMcpJson('/llm/providers')
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    res.json(upstream.body)
  } catch (err) {
    next(err)
  }
})

llmModelsRouter.get('/workspaces/stats', async (_req, res, next) => {
  try {
    const upstream = await fetchMcpJson('/mcp/workspaces/stats')
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    res.json(upstream.body)
  } catch (err) {
    next(err)
  }
})

llmModelsRouter.get('/execution', async (_req, res, next) => {
  try {
    const upstream = await fetchMcpJson('/mcp/discovery')
    if (!upstream.ok) return res.status(upstream.status).json(upstream.body)
    const root = upstream.body as { data?: { commandExecution?: unknown } }
    res.json({ success: true, data: root.data?.commandExecution ?? null })
  } catch (err) {
    next(err)
  }
})
