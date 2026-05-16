// M11 follow-up — OTel auto-instrumentation. MUST be first.
import "./lib/observability/otel";

import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { toolRoutes } from "./routes/tools";
import { discoveryRoutes } from "./routes/discovery";
import { executionRoutes } from "./routes/execution";
import { runnerRoutes } from "./routes/runners";
import { internalToolsRoutes } from "./routes/internal-tools";
import { connectorToolsRoutes } from "./routes/connector-tools";
import { errorHandler } from "./middleware/errorHandler";
import { optionalAuth, requireAuth } from "./middleware/auth";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startEventDispatcher } from "./lib/eventbus/dispatcher";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";
import { seedCoreToolkit } from "./lib/seed-core-tools";

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3002;

function authOptional(): boolean {
  return process.env.AUTH_OPTIONAL === "true";
}

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "singularity-tool-service", timestamp: new Date().toISOString() });
});

// M28 boot-1 — strict invariants. 200 only when DB reachable + tool.tools
// exists + >= 10 core tools seeded. 503 + failing-check names otherwise.
app.get("/healthz/strict", async (_req, res) => {
  const { runInvariantChecks } = await import("./healthz-strict");
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    ok: result.ok,
    service: "singularity-tool-service",
    checks: result.checks,
  });
});

app.use(authOptional() ? optionalAuth : requireAuth);

app.use("/api/v1/tools", toolRoutes);
app.use("/api/v1/tools", discoveryRoutes);
app.use("/api/v1/tools", executionRoutes);
app.use("/api/v1", runnerRoutes);
// M18 — internal endpoints that back the server-side core tools.
app.use("/api/v1/internal-tools", internalToolsRoutes);
// M19 — connector tool wrappers (proxy to workgraph /api/connectors/:id/invoke).
app.use("/api/v1/connector-tools", connectorToolsRoutes);
// M11.e — event-bus subscription registry
app.use("/api/v1/events/subscriptions", eventSubscriptionsRouter);

app.use(errorHandler);

// M11.e — start dispatcher (LISTEN/NOTIFY + safety sweep)
void startEventDispatcher().catch((err) => {
  console.warn(`[eventbus] dispatcher failed to start: ${(err as Error).message}`);
});

// M11.a — self-register with platform-registry (no-op if env unset)
startSelfRegistration({
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

// M18 — seed the core toolkit (idempotent — only inserts missing rows).
void seedCoreToolkit().catch((err) => {
  console.warn(`[tool-service] core-toolkit seed failed: ${(err as Error).message}`);
});

app.listen(PORT, () => {
  console.log(`[tool-service] listening on port ${PORT}`);
});

export default app;
