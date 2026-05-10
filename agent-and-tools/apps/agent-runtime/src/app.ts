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
import { optionalAuth } from "./middleware/auth.middleware";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";
import { prisma } from "./config/prisma";

// M3: prompt assembly is now owned by prompt-composer (port 3004).
// agent-runtime no longer exposes /api/v1/prompts.
// The src/modules/prompts/* files are kept for internal use by
// executions/execution.service.ts (which will move to workgraph in M5).

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "25mb" })); // M14 — code-extract payloads can carry hundreds of source files
app.use(requestIdMiddleware);
app.use(optionalAuth);

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: { status: "ok", service: "singularity-agent-runtime", timestamp: new Date().toISOString() },
    error: null,
    requestId: res.locals.requestId,
  });
});

app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/tools", toolRoutes);
app.use("/api/v1/capabilities", capabilityRoutes);
app.use("/api/v1/executions", executionRoutes);
app.use("/api/v1/memory", memoryRoutes);
// M11.e — event-bus subscription registry. Dispatcher itself starts in server.ts.
app.use("/api/v1/events/subscriptions", eventSubscriptionsRouter(prisma));

app.use(errorMiddleware);
