import express from 'express'
import { pinoHttp } from 'pino-http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config } from './config.js'
import { runMigrations } from './db/pool.js'
import { registryRoutes } from './routes/registry.js'

const here  = dirname(fileURLToPath(import.meta.url))
const dbDir = join(here, '..', 'db')

async function main(): Promise<void> {
  await runMigrations([
    { name: '001_init', sql: readFileSync(join(dbDir, '001_init.sql'), 'utf8') },
  ])

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(pinoHttp({ quietReqLogger: true }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'singularity-platform-registry', version: '0.1.0' })
  })

  app.use('/api/v1', registryRoutes)

  const server = app.listen(config.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[platform-registry] listening on :${config.PORT}`)
  })

  function shutdown() {
    // eslint-disable-next-line no-console
    console.log('[platform-registry] shutting down')
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[platform-registry] fatal:', err)
  process.exit(1)
})
