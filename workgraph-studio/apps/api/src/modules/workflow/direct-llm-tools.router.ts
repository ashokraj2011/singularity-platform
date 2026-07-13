import { Router } from 'express'
import { directLlmToolCatalog } from './loop-strategy.service'

/** Read-only catalog for the Direct LLM editor. Strategy CRUD stays on the
 * loop-strategies resource and is never accidentally exposed here. */
export const directLlmToolsRouter: Router = Router()

directLlmToolsRouter.get('/', (_req, res) => {
  res.json({ items: directLlmToolCatalog() })
})
