// M11 follow-up — OTel auto-instrumentation. MUST be first.
import "./lib/observability/otel";

import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { assertProductionInvariant, assertProductionSecret } from "@agentandtools/shared";
// ── Agent domain ──
import { agentRoutes } from "./routes/agents";
import { versionRoutes } from "./routes/versions";
import { learningRoutes } from "./routes/learning";
import { learningPatternsRoutes, ensureLearningSchema } from "./routes/learning-patterns";
import { runtimeRoutes } from "./routes/runtime";
import { errorHandler } from "./middleware/errorHandler";
import { optionalAuth, requireAuth } from "./middleware/auth";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startEventDispatcher } from "./lib/eventbus/dispatcher";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";
// ── Tool domain (Phase 4 — tool-service merged in as the ./tool subtree, which
// keeps its OWN database/eventbus/middleware/libs so behavior is unchanged) ──
import { toolRoutes } from "./tool/routes/tools";
import { discoveryRoutes } from "./tool/routes/discovery";
import { executionRoutes } from "./tool/routes/execution";
import { runnerRoutes } from "./tool/routes/runners";
import { internalToolsRoutes } from "./tool/routes/internal-tools";
import { connectorToolsRoutes } from "./tool/routes/connector-tools";
import { startEventDispatcher as startToolEventDispatcher } from "./tool/lib/eventbus/dispatcher";
import { startSelfRegistration as startToolSelfRegistration } from "./tool/lib/platform-registry/register";
import { seedCoreToolkit } from "./tool/lib/seed-core-tools";

dotenv.config();

// M35.1 — refuse to start in prod-class envs with a default JWT_SECRET.
assertProductionSecret({ name: "JWT_SECRET", value: process.env.JWT_SECRET });
assertProductionSecret({ name: "MCP_BEARER_TOKEN", value: process.env.MCP_BEARER_TOKEN, minLength: 32 });
assertProductionSecret({ name: "AUDIT_GOV_SERVICE_TOKEN", value: process.env.AUDIT_GOV_SERVICE_TOKEN, minLength: 32 });
assertProductionInvariant({
  name: "AUTH_OPTIONAL",
  ok: process.env.AUTH_OPTIONAL !== "true",
  message: "set AUTH_OPTIONAL=false or omit it; production services must require IAM auth",
});

const app = express();
const PORT = process.env.PORT ?? 3001;

function authOptional(): boolean {
  return process.env.AUTH_OPTIONAL === "true";
}

app.use(helmet());
// M35.3 — tighten CORS: restrict to configured origins and enable credentials
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000").split(",").map(o => o.trim());
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "singularity-agent-resource-service", timestamp: new Date().toISOString() });
});

// M28 boot-1 — strict invariants (tool domain). 200 only when DB reachable +
// tool.tools exists + >= 10 core tools seeded. 503 + failing-check names otherwise.
app.get("/healthz/strict", async (_req, res) => {
  const { runInvariantChecks } = await import("./tool/healthz-strict");
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    ok: result.ok,
    service: "singularity-agent-resource-service",
    checks: result.checks,
  });
});

// ── finding 10 — liveness vs readiness ──
// /health (above) is LIVENESS: 200 whenever the process is up.
// /ready is READINESS: 200 only once the DB + tool-schema invariants pass AND
// the async bootstrap (learning-schema ensure, core-toolkit seed, event
// dispatchers) has not hard-failed — so an orchestrator doesn't route traffic
// to a half-initialized instance. It reuses /healthz/strict's invariants and
// adds the bootstrap view that those invariants don't cover (dispatchers).
type BootStep = "pending" | "ok" | "failed";
const bootstrapState: Record<
  "agentDispatcher" | "toolDispatcher" | "learningSchema" | "coreToolkit",
  BootStep
> = {
  agentDispatcher: "pending",
  toolDispatcher: "pending",
  learningSchema: "pending",
  coreToolkit: "pending",
};

app.get("/ready", async (_req, res) => {
  const { runInvariantChecks } = await import("./tool/healthz-strict");
  const invariants = await runInvariantChecks();
  const b = bootstrapState;
  // A dispatcher still "pending" does NOT block readiness — its start promise
  // may stay unresolved while the drain loop runs. Only a hard "failed" blocks.
  // learningSchema must reach "ok" (not covered by the invariants); the seed is
  // also covered by the invariants' >=10-core-tools check.
  const failed = Object.entries(b)
    .filter(([, v]) => v === "failed")
    .map(([k]) => k);
  const ok = invariants.ok && failed.length === 0 && b.learningSchema === "ok";
  res.status(ok ? 200 : 503).json({
    ok,
    service: "singularity-agent-resource-service",
    invariants: invariants.checks,
    bootstrap: b,
    ...(failed.length ? { failed } : {}),
  });
});

app.use(authOptional() ? optionalAuth : requireAuth);

// ── Agent domain routes ──
app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/agents", versionRoutes);
app.use("/api/v1/agents", learningRoutes);
// M67 Slice 1A — folded-in learning-service routes.
app.use("/api/v1", learningPatternsRoutes);
app.use("/api/v1", runtimeRoutes);

// ── Tool domain routes (each tool router self-applies requireAuth) ──
app.use("/api/v1/tools", toolRoutes);
app.use("/api/v1/tools", discoveryRoutes);
app.use("/api/v1/tools", executionRoutes);
app.use("/api/v1", runnerRoutes);
// M18 — internal endpoints that back the server-side core tools.
app.use("/api/v1/internal-tools", internalToolsRoutes);
// M19 — connector tool wrappers (proxy to workgraph /api/connectors/:id/invoke).
app.use("/api/v1/connector-tools", connectorToolsRoutes);

// M11.e — event-bus subscription registry. Agent-schema-backed; tool event
// DELIVERY still works (the tool dispatcher reads tool.event_subscriptions
// directly). Unifying the subscription-management API across both schemas is a
// follow-up.
app.use("/api/v1/events/subscriptions", eventSubscriptionsRouter);

app.use(errorHandler);

// M11.e — start BOTH dispatchers; they drain separate outboxes
// (agent.event_outbox / tool.event_outbox), so there is no contention.
void startEventDispatcher()
  .then(() => {
    bootstrapState.agentDispatcher = "ok";
  })
  .catch((err) => {
    bootstrapState.agentDispatcher = "failed";
    console.warn(`[eventbus] agent dispatcher failed to start: ${(err as Error).message}`);
  });
void startToolEventDispatcher()
  .then(() => {
    bootstrapState.toolDispatcher = "ok";
  })
  .catch((err) => {
    bootstrapState.toolDispatcher = "failed";
    console.warn(`[eventbus] tool dispatcher failed to start: ${(err as Error).message}`);
  });

// M11.a — self-register both logical capability sets (no-op if env unset). Both
// resolve to this one process/port now.
startSelfRegistration({
  service_name: "agent-service",
  display_name: "Singularity Agent Service",
  version:      "0.1.0",
  base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`,
  health_path:  "/health",
  auth_mode:    "bearer-iam",
  owner_team:   "agent-and-tools",
  metadata:     { layer: "domain" },
  capabilities: [
    { capability_key: "agent.crud",     description: "Agent definition CRUD" },
    { capability_key: "agent.versions", description: "Agent versioning + promotion" },
    { capability_key: "agent.learning", description: "Learning candidates + profiles pipeline" },
  ],
});
startToolSelfRegistration({
  service_name: "tool-service",
  display_name: "Singularity Tool Service",
  version:      "0.1.0",
  base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`,
  health_path:  "/health",
  auth_mode:    "bearer-iam",
  owner_team:   "agent-and-tools",
  metadata:     { layer: "domain" },
  capabilities: [
    { capability_key: "tool.registry",   description: "Tool registration + versioning" },
    { capability_key: "tool.discovery",  description: "Capability-scoped tool discovery + ranking" },
    { capability_key: "tool.execution",  description: "Server-side tool execution + grants" },
    { capability_key: "tool.runners",    description: "Client-runner heartbeat registry" },
  ],
});

// M67 Slice 1A — Ensure the learning.* schema exists (idempotent).
void ensureLearningSchema()
  .then(() => {
    bootstrapState.learningSchema = "ok";
  })
  .catch((err) => {
    bootstrapState.learningSchema = "failed";
    console.warn(`[agent-resource-service] learning schema bootstrap failed: ${(err as Error).message}`);
  });

// M18 — seed the core toolkit (idempotent — only inserts missing rows).
void seedCoreToolkit()
  .then(() => {
    bootstrapState.coreToolkit = "ok";
  })
  .catch((err) => {
    bootstrapState.coreToolkit = "failed";
    console.warn(`[agent-resource-service] core-toolkit seed failed: ${(err as Error).message}`);
  });

app.listen(PORT, () => {
  console.log(`[agent-resource-service] listening on port ${PORT} (agents + tools)`);
});

export default app;
