import { createApp } from './app'
import { config } from './config'
import { prisma } from './lib/prisma'
import { ensureBucket } from './lib/minio'
import { startOutboxProcessor } from './modules/audit/outbox/OutboxProcessor'
import { startTimerSweep } from './modules/workflow/runtime/TimerSweep'
import { startTriggerScheduler } from './modules/workflow/triggers/TriggerScheduler'
import { startSelfRegistration } from './lib/platform-registry/register'
import { startEventDispatcher } from './lib/eventbus/dispatcher'

async function main() {
  // Verify DB connection
  await prisma.$connect()
  console.log('Database connected')

  // Ensure MinIO bucket exists (3 s timeout — server starts even if MinIO is down)
  try {
    await Promise.race([
      ensureBucket(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
  } catch (err) {
    console.warn('MinIO unavailable at startup — documents will be unavailable:', (err as Error).message)
  }

  // Start background pollers
  startOutboxProcessor()
  startTimerSweep()
  startTriggerScheduler()

  // M11.e — event-bus dispatcher (LISTEN/NOTIFY + safety sweep)
  await startEventDispatcher().catch((err) => {
    console.warn('[eventbus] dispatcher failed to start:', (err as Error).message)
  })

  // M11.a — self-register with platform-registry (no-op if env unset)
  startSelfRegistration({
    service_name: 'workgraph-api',
    display_name: 'WorkGraph API',
    version:      '0.1.0',
    base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`,
    health_path:  '/health',
    auth_mode:    config.AUTH_PROVIDER === 'iam' ? 'bearer-iam' : 'bearer-static',
    owner_team:   'platform',
    metadata:     { layer: 'orchestration' },
    capabilities: [
      { capability_key: 'workflow.design',    description: 'Workflow design CRUD + design editor backing' },
      { capability_key: 'workflow.runtime',   description: 'DAG executor, timers, signals, approvals' },
      { capability_key: 'lookup.federated',   description: 'Cross-service /api/lookup/* proxy (M10)' },
      { capability_key: 'agent.snapshot',     description: 'Snapshots agent-and-tools templates at run start (M10)' },
      { capability_key: 'audit.outbox',       description: 'Audit event log + outbox dispatcher' },
    ],
    contracts: [
      { kind: 'openapi', contract_key: 'openapi', version: '0.1.0', source_url: `${process.env.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`}/openapi.json` },
    ],
  })

  const app = createApp()
  app.listen(config.PORT, () => {
    console.log(`WorkGraph API listening on port ${config.PORT}`)
  })
}

main().catch(err => {
  console.error('Startup error:', err)
  process.exit(1)
})
