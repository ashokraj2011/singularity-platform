/**
 * M42.1 — Code Foundry HTTP app.
 *
 * Two un-gated endpoints (health, healthz/strict) and one gated mount
 * (/api/codegen). Auth is service-token-bearer at the IP boundary; the
 * codegen routes use the shared feature-flag client for the kill
 * switch, not for auth.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import pinoHttp from 'pino-http'
import { log } from './lib/log.js'
import { config } from './config.js'
import { AppError } from './lib/errors.js'
import { codegenRouter } from './api/router.js'

export function createApp(): Express {
  const app = express()

  app.use(pinoHttp({ logger: log, quietReqLogger: true }))
  // YAML is optional and accepted by routes that parse it themselves;
  // JSON is the default surface so admin tools work out of the box.
  app.use(express.json({ limit: '8mb' }))
  app.use(express.text({
    type: ['application/yaml', 'text/yaml', 'application/x-yaml', 'text/plain', 'text/x-diff', 'application/x-patch'],
    limit: '8mb',
  }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'UP', service: 'code-foundry-api', timestamp: new Date().toISOString() })
  })

  app.get('/healthz/strict', async (_req, res) => {
    // Liveness + DB reachability. Feature-flag reachability is checked
    // lazily by routes themselves; not a hard boot invariant.
    try {
      const { prisma } = await import('./lib/prisma.js')
      await prisma.$queryRaw`SELECT 1`
      res.json({ ok: true, service: 'code-foundry-api', checks: { db: { ok: true } } })
    } catch (err) {
      res.status(503).json({ ok: false, service: 'code-foundry-api', error: (err as Error).message })
    }
  })

  app.use('/api/codegen', codegenRouter)

  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    if (err instanceof AppError) {
      return res.status(err.status).json({ code: err.code, message: err.message, details: err.details ?? null })
    }
    log.error({ err: err.message, stack: err.stack }, 'unhandled error')
    res.status(500).json({ code: 'INTERNAL', message: err.message })
  })

  log.info(`code-foundry-api listening config — port=${config.PORT}, gen=${config.GENERATOR_VERSION}`)
  return app
}
