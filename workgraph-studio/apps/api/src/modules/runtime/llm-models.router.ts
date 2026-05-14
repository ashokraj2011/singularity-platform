import { Router, type Router as ExpressRouter } from 'express'
import { config } from '../../config'

export const llmModelsRouter: ExpressRouter = Router()

llmModelsRouter.get('/models', async (_req, res, next) => {
  try {
    const url = `${config.MCP_SERVER_URL.replace(/\/$/, '')}/llm/models`
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.status(upstream.status).json({
        error: 'MCP_MODEL_CATALOG_UNAVAILABLE',
        message: text || `MCP returned ${upstream.status}`,
      })
      return
    }
    res.json(await upstream.json())
  } catch (err) {
    next(err)
  }
})
