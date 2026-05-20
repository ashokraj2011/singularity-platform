import { Router, type Router as ExpressRouter } from 'express'
import { config } from '../../config'

export const llmModelsRouter: ExpressRouter = Router()

async function fetchMcpJson(path: string) {
  const url = `${config.MCP_SERVER_URL.replace(/\/$/, '')}${path}`
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
  })
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return {
      ok: false as const,
      status: upstream.status,
      body: {
        error: path.includes('/workspaces/')
          ? 'MCP_WORKSPACE_STATS_UNAVAILABLE'
          : path.includes('/discovery')
            ? 'MCP_DISCOVERY_UNAVAILABLE'
            : 'MCP_MODEL_CATALOG_UNAVAILABLE',
        message: text || `MCP returned ${upstream.status}`,
      },
    }
  }
  return { ok: true as const, body: await upstream.json() }
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
