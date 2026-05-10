import express, { Express } from 'express'
import cors from 'cors'
import { pinoHttp } from 'pino-http'
import { config } from './config'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'

import { authRouter } from './modules/identity/auth.router'
import { usersRouter } from './modules/identity/users.router'
import { teamsRouter } from './modules/identity/teams.router'
import { rolesRouter } from './modules/identity/roles.router'
import { skillsRouter } from './modules/identity/skills.router'
import { permissionsRouter } from './modules/identity/permissions.router'
// Out of scope: Initiatives no longer mounted (see plan: Workflow Designer + Engine boundary).
// import { initiativesRouter } from './modules/initiative/initiatives.router'
import { workflowTemplatesRouter } from './modules/workflow/templates.router'
import { workflowInstancesRouter } from './modules/workflow/instances.router'
import { triggersRouter, webhookRouter } from './modules/workflow/triggers/triggers.router'
import { customNodeTypesRouter } from './modules/workflow/custom-node-types.router'
import { tasksRouter } from './modules/task/tasks.router'
import { approvalsRouter } from './modules/approval/approvals.router'
import { consumableTypesRouter } from './modules/consumable/consumable-types.router'
import { consumablesRouter } from './modules/consumable/consumables.router'
import { agentsRouter } from './modules/agent/agents.router'
import { agentRunsRouter } from './modules/agent/agent-runs.router'
import { toolsRouter } from './modules/tool/tools.router'
import { toolRunsRouter } from './modules/tool/tool-runs.router'
import { auditRouter } from './modules/audit/audit.router'
import { documentsRouter } from './modules/document/documents.router'
import { runtimeRouter } from './modules/runtime/runtime.router'
import { snapshotsRouter } from './modules/runtime/snapshots.router'
import { codeChangesRouter } from './modules/runtime/code-changes.router'
import { notifyRouter } from './modules/notify/notify.router'
import { connectorsRouter } from './modules/connectors/connectors.router'
import { artifactTemplatesRouter } from './modules/artifact/artifact-templates.router'
import { lookupRouter } from './modules/lookup/lookup.router'
import { receiptsRouter } from './modules/audit/receipts.router'
import { eventSubscriptionsRouter } from './modules/audit/event-subscriptions.router'
import { incomingEventsRouter } from './modules/audit/incoming-events.router'

export function createApp(): Express {
  const app = express()

  app.use(pinoHttp({ quietReqLogger: true }))
  app.use(express.json({ limit: '10mb' }))
  app.use(
    cors({
      origin: config.CORS_ORIGINS.split(',').map(o => o.trim()),
      credentials: true,
    }),
  )

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'UP', timestamp: new Date().toISOString() })
  })

  // Auth (no auth middleware)
  app.use('/api/auth', authRouter)

  // Protected routes
  app.use('/api/users', authMiddleware, usersRouter)
  app.use('/api/teams', authMiddleware, teamsRouter)
  app.use('/api/roles', authMiddleware, rolesRouter)
  app.use('/api/skills', authMiddleware, skillsRouter)
  app.use('/api/permissions', authMiddleware, permissionsRouter)
  // app.use('/api/initiatives', authMiddleware, initiativesRouter) — out of scope
  app.use('/api/workflow-templates', authMiddleware, workflowTemplatesRouter)
  app.use('/api/workflow-instances', authMiddleware, workflowInstancesRouter)
  app.use('/api/workflow-triggers', authMiddleware, triggersRouter)
  app.use('/api/custom-node-types', authMiddleware, customNodeTypesRouter)
  // Webhook receiver is intentionally unauthenticated; secret-gated.
  app.use('/api/triggers/webhook', webhookRouter)
  app.use('/api/tasks', authMiddleware, tasksRouter)
  app.use('/api/approvals', authMiddleware, approvalsRouter)
  app.use('/api/consumable-types', authMiddleware, consumableTypesRouter)
  app.use('/api/consumables', authMiddleware, consumablesRouter)
  app.use('/api/agents', authMiddleware, agentsRouter)
  app.use('/api/agent-runs', authMiddleware, agentRunsRouter)
  app.use('/api/tools', authMiddleware, toolsRouter)
  app.use('/api/tool-runs', authMiddleware, toolRunsRouter)
  app.use('/api/audit', authMiddleware, auditRouter)
  // app.use('/api/documents', authMiddleware, documentsRouter) — out of scope
  app.use('/api/connectors', authMiddleware, connectorsRouter)
  app.use('/api/artifact-templates', authMiddleware, artifactTemplatesRouter)
  app.use('/api/documents', authMiddleware, documentsRouter)
  app.use('/api/runtime',   authMiddleware, runtimeRouter)
  app.use('/api/runs',      authMiddleware, snapshotsRouter)
  app.use('/api/runs',      authMiddleware, codeChangesRouter)
  app.use('/api/notify',    authMiddleware, notifyRouter)

  // M10 — federated reference-data lookups (forwards user JWT to source services)
  app.use('/api/lookup',    authMiddleware, lookupRouter)

  // M11.d — unified cross-service receipt timeline
  app.use('/api/receipts',  authMiddleware, receiptsRouter)

  // M11.e — event-bus subscription registry (the dispatcher itself runs in index.ts)
  app.use('/api/events/subscriptions', authMiddleware, eventSubscriptionsRouter)
  // M11.e cross-service inbound — webhook receiver (signature-gated, NOT auth-middleware-gated)
  app.use('/api/events/incoming',     incomingEventsRouter)

  app.use(errorHandler)

  return app
}
