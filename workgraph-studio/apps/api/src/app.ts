import express, { Express, type Request } from 'express'
import cors from 'cors'
import { pinoHttp } from 'pino-http'
import { config } from './config'
import { errorHandler } from './middleware/errorHandler'
import { authMiddleware } from './middleware/auth'
import { tenantDbContextMiddleware } from './lib/tenant-db-context'

import { authRouter } from './modules/identity/auth.router'
import { usersRouter } from './modules/identity/users.router'
import { teamsRouter } from './modules/identity/teams.router'
import { identitySyncRouter } from './modules/identity/sync.router'
import { rolesRouter } from './modules/identity/roles.router'
import { skillsRouter } from './modules/identity/skills.router'
import { permissionsRouter } from './modules/identity/permissions.router'
// Out of scope: Initiatives no longer mounted (see plan: Workflow Designer + Engine boundary).
// import { initiativesRouter } from './modules/initiative/initiatives.router'
import { workflowTemplatesRouter } from './modules/workflow/templates.router'
import { workflowInstancesRouter } from './modules/workflow/instances.router'
import { insightsRouter } from './modules/workflow/insights.router'
import { triggersRouter, webhookRouter } from './modules/workflow/triggers/triggers.router'
import { customNodeTypesRouter } from './modules/workflow/custom-node-types.router'
import { workbenchDefinitionsRouter } from './modules/workflow/workbench-definitions.router'
import { tasksRouter } from './modules/task/tasks.router'
import { approvalsRouter } from './modules/approval/approvals.router'
import { consumableTypesRouter } from './modules/consumable/consumable-types.router'
import { consumablesRouter } from './modules/consumable/consumables.router'
import { agentsRouter } from './modules/agent/agents.router'
import { agentRunsRouter } from './modules/agent/agent-runs.router'
import { toolsRouter } from './modules/tool/tools.router'
import { toolRunsRouter } from './modules/tool/tool-runs.router'
import { toolRegistryRouter } from './modules/tool-registry/tool-registry.router'
import { auditRouter } from './modules/audit/audit.router'
import { curationRouter } from './modules/audit/curation.router'
import { documentsRouter } from './modules/document/documents.router'
import { runtimeRouter } from './modules/runtime/runtime.router'
import { snapshotsRouter } from './modules/runtime/snapshots.router'
import { codeChangesRouter } from './modules/runtime/code-changes.router'
import { llmModelsRouter } from './modules/runtime/llm-models.router'
import { notifyRouter } from './modules/notify/notify.router'
import { connectorsRouter } from './modules/connectors/connectors.router'
import { artifactTemplatesRouter } from './modules/artifact/artifact-templates.router'
import { lookupRouter } from './modules/lookup/lookup.router'
import { agentStudioRouter } from './modules/agent-studio/agent-studio.router'
import { receiptsRouter } from './modules/audit/receipts.router'
import { eventSubscriptionsRouter } from './modules/audit/event-subscriptions.router'
import { incomingEventsRouter } from './modules/audit/incoming-events.router'
import { blueprintRouter } from './modules/blueprint/blueprint.router'
import { eventHorizonRouter } from './modules/event-horizon/event-horizon.router'
import { llmRoutingRouter } from './modules/llm-routing/llm-routing.router'
import { codegenRouter } from './modules/codegen/codegen.router'
// M40 — ImmutableContract replay + lookup endpoints.
import { contractsRouter } from './modules/contracts/contracts.router'
import { workItemsRouter } from './modules/work-items/work-items.router'
import { plannerRouter } from './modules/planner/planner.router'
import { governanceRouter } from './modules/governance/governance.router'
import { eventVerifierDemoRouter } from './modules/demo/event-verifier.router'
import { workItemRoutingPoliciesRouter, workItemTriggersRouter } from './modules/work-items/work-item-routing.router'
import { metadataDefinitionsRouter } from './modules/metadata/metadata.router'
import { laptopInvocationsRouter, laptopQuestionsRouter, workItemLaptopRouter } from './modules/laptop/laptop.router'
import { internalArtifactFetchRouter } from './modules/internal/artifact-fetch.router'
// M42.0 — admin feature-flag toggles (kill switches for major capabilities).
// M42.1 — internalFeatureFlagsRouter is the service-token-gated read-only
// feature-flag mirror for trusted internal workers.
import { featureFlagsRouter, internalFeatureFlagsRouter } from './modules/admin/feature-flags.router'

type RawBodyRequest = Request & { rawBody?: Buffer }

function captureRawJsonBody(req: Request, _res: unknown, buf: Buffer): void {
  const rawReq = req as RawBodyRequest
  rawReq.rawBody = Buffer.from(buf)
}

export function createApp(): Express {
  const app = express()

  app.use(pinoHttp({ quietReqLogger: true }))
  app.use(express.json({ limit: '10mb', verify: captureRawJsonBody }))
  app.use(tenantDbContextMiddleware)
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

  // M28 boot-1 — strict invariants. 200 only when DB reachable + M24.5
  // workflow_nodes timing columns present + IAM reachable (if AUTH_PROVIDER=iam).
  // 503 + failing-check names otherwise.
  app.get('/healthz/strict', async (_req, res) => {
    const { runInvariantChecks } = await import('./healthz-strict')
    const result = await runInvariantChecks()
    res.status(result.ok ? 200 : 503).json({
      ok: result.ok,
      service: 'workgraph-api',
      checks: result.checks,
    })
  })

  // Auth (no auth middleware)
  app.use('/api/auth', authRouter)

  // Service-token endpoint for bounded artifact text fetch by prompt-composer.
  app.use('/api/internal/artifacts', internalArtifactFetchRouter)

  // Protected routes
  app.use('/api/users', authMiddleware, usersRouter)
  app.use('/api/teams', authMiddleware, teamsRouter)
  app.use('/api/identity', authMiddleware, identitySyncRouter)
  app.use('/api/roles', authMiddleware, rolesRouter)
  app.use('/api/skills', authMiddleware, skillsRouter)
  app.use('/api/permissions', authMiddleware, permissionsRouter)
  // app.use('/api/initiatives', authMiddleware, initiativesRouter) — out of scope
  app.use('/api/workflow-templates', authMiddleware, workflowTemplatesRouter)
  // Compatibility/BFF alias used by WorkItem and readiness flows.
  // Workflow templates remain the source of truth; this path keeps the
  // operator-facing wording short without creating a second resource model.
  app.use('/api/workflows', authMiddleware, workflowTemplatesRouter)
  app.use('/api/workflow-instances', authMiddleware, workflowInstancesRouter)
  // M24 — run insights composite (sub-router; same /api/workflow-instances prefix)
  app.use('/api/workflow-instances', authMiddleware, insightsRouter)
  app.use('/api/workflow-triggers', authMiddleware, triggersRouter)
  app.use('/api/custom-node-types', authMiddleware, customNodeTypesRouter)
  // M84.s2 — first-class workbench definitions. The :nodeId param
  // identifies the WORKBENCH_TASK WorkflowNode that owns the
  // definition tree. mergeParams: true on the router lets handlers
  // read it via req.params.nodeId.
  app.use('/api/workflow-nodes/:nodeId/workbench', authMiddleware, workbenchDefinitionsRouter)
  // Webhook receiver is intentionally unauthenticated; secret-gated.
  app.use('/api/triggers/webhook', webhookRouter)
  app.use('/api/tasks', authMiddleware, tasksRouter)
  app.use('/api/metadata-definitions', authMiddleware, metadataDefinitionsRouter)
  app.use('/api/work-item-routing-policies', authMiddleware, workItemRoutingPoliciesRouter)
  app.use('/api/work-item-triggers', authMiddleware, workItemTriggersRouter)
  app.use('/api/work-items', authMiddleware, workItemLaptopRouter)
  app.use('/api/work-items', authMiddleware, workItemsRouter)
  app.use('/api/planner', authMiddleware, plannerRouter)
  app.use('/api/governance', authMiddleware, governanceRouter)
  app.use('/api/demo/event-verifier', authMiddleware, eventVerifierDemoRouter)
  app.use('/api/laptop-invocations', authMiddleware, laptopInvocationsRouter)
  app.use('/api/questions', authMiddleware, laptopQuestionsRouter)
  app.use('/api/approvals', authMiddleware, approvalsRouter)
  app.use('/api/consumable-types', authMiddleware, consumableTypesRouter)
  app.use('/api/consumables', authMiddleware, consumablesRouter)
  app.use('/api/agents', authMiddleware, agentsRouter)
  app.use('/api/agent-runs', authMiddleware, agentRunsRouter)
  app.use('/api/tools', authMiddleware, toolsRouter)
  app.use('/api/tool-runs', authMiddleware, toolRunsRouter)
  // M91.B (2026-05-27) — canonical tool registry. Reads the embedded
  // mirror of agent-and-tools/packages/tool-registry/src/tools.json.
  // Designer (M91.C) consumes via fetch instead of bundling.
  app.use('/api/tool-registry', authMiddleware, toolRegistryRouter)
  app.use('/api/audit', authMiddleware, auditRouter)
  // Operator curation gate (task #111) — proxies audit-gov's engine
  // dataset endpoints. Mounted at /api/engine so the path mirrors
  // audit-gov's /api/v1/engine/* shape (minus the version segment).
  app.use('/api/engine', authMiddleware, curationRouter)
  // app.use('/api/documents', authMiddleware, documentsRouter) — out of scope
  app.use('/api/connectors', authMiddleware, connectorsRouter)
  app.use('/api/artifact-templates', authMiddleware, artifactTemplatesRouter)
  app.use('/api/blueprint', authMiddleware, blueprintRouter)
  app.use('/api/event-horizon', authMiddleware, eventHorizonRouter)
  app.use('/api/llm-routing', authMiddleware, llmRoutingRouter)
  // Workgraph-owned Code Generation / Foundry compatibility surface.
  // Platform Web still calls /api/codegen/*; the backing data now lives in
  // Workgraph instead of a standalone Foundry API container.
  app.use('/api/codegen', authMiddleware, codegenRouter)
  // M40 — ImmutableContract surface (proxy lookup + replay)
  app.use('/api/contracts', authMiddleware, contractsRouter)
  app.use('/api/documents', authMiddleware, documentsRouter)
  app.use('/api/runtime',   authMiddleware, runtimeRouter)
  app.use('/api/runs',      authMiddleware, snapshotsRouter)
  app.use('/api/runs',      authMiddleware, codeChangesRouter)
  app.use('/api/llm',       authMiddleware, llmModelsRouter)
  app.use('/api/notify',    authMiddleware, notifyRouter)

  // M10 — federated reference-data lookups (forwards user JWT to source services)
  app.use('/api/lookup',    authMiddleware, lookupRouter)
  // M23 — Agent Studio facade (governance + derivation on top of agent-runtime)
  app.use('/api/agent-studio', authMiddleware, agentStudioRouter)

  // M11.d — unified cross-service receipt timeline
  app.use('/api/receipts',  authMiddleware, receiptsRouter)

  // M11.e — event-bus subscription registry (the dispatcher itself runs in index.ts)
  app.use('/api/events/subscriptions', authMiddleware, eventSubscriptionsRouter)
  // M11.e cross-service inbound — webhook receiver (signature-gated, NOT auth-middleware-gated)
  app.use('/api/events/incoming',     incomingEventsRouter)

  // M42.0 — admin feature flags (Code Foundry kill switches, etc.). PUT is
  // ADMIN-only inside the router; GET is read-only for any authenticated
  // user so the Foundry's CLI/REST/web entry points can check the gate.
  app.use('/api/admin/feature-flags', authMiddleware, featureFlagsRouter)
  // M42.1 — service-token-gated read-only mirror for trusted workers.
  // Same data, different auth path (no user JWT required).
  app.use('/api/internal/feature-flags', internalFeatureFlagsRouter)

  app.use(errorHandler)

  return app
}
