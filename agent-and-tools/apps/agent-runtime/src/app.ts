import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { agentRoutes } from "./modules/agents/agent.routes";
import { toolRoutes } from "./modules/tools/tool.routes";
import { capabilityRoutes } from "./modules/capabilities/capability.routes";
import { executionRoutes } from "./modules/executions/execution.routes";
import { memoryRoutes } from "./modules/memory/memory.routes";
import { errorMiddleware } from "./middleware/error.middleware";
import { requestIdMiddleware } from "./middleware/request-id.middleware";
import { optionalAuth, requireAuth } from "./middleware/auth.middleware";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";
import { prisma } from "./config/prisma";
import { env } from "./config/env";

// M3: prompt assembly is now owned by prompt-composer (port 3004).
// agent-runtime no longer exposes /api/v1/prompts.
// The src/modules/prompts/* files are kept for internal use by
// executions/execution.service.ts (which will move to workgraph in M5).

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "25mb" })); // M14 — code-extract payloads can carry hundreds of source files
app.use(requestIdMiddleware);

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: { status: "ok", service: "singularity-agent-runtime", timestamp: new Date().toISOString() },
    error: null,
    requestId: res.locals.requestId,
  });
});

// M28 boot-1 — strict invariants. 200 only when DB reachable + AgentTemplate
// M23 columns present + tool.tools table present + PromptAssembly.traceId
// column present. 503 + failing-check names otherwise.
app.get("/healthz/strict", async (_req, res) => {
  const { runInvariantChecks } = await import("./healthz-strict");
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    success: result.ok,
    data: { ok: result.ok, service: "singularity-agent-runtime", checks: result.checks },
    error: null,
    requestId: res.locals.requestId,
  });
});

app.use(env.AUTH_OPTIONAL ? optionalAuth : requireAuth);

app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/tools", toolRoutes);
app.use("/api/v1/capabilities", capabilityRoutes);
app.use("/api/v1/executions", executionRoutes);
app.use("/api/v1/memory", memoryRoutes);
// M11.e — event-bus subscription registry. Dispatcher itself starts in server.ts.
app.use("/api/v1/events/subscriptions", eventSubscriptionsRouter(prisma));

app.use(errorMiddleware);
