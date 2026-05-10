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
import { errorHandler } from "./middleware/errorHandler";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startEventDispatcher } from "./lib/eventbus/dispatcher";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3002;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "singularity-tool-service", timestamp: new Date().toISOString() });
});

app.use("/api/v1/tools", toolRoutes);
app.use("/api/v1/tools", discoveryRoutes);
app.use("/api/v1/tools", executionRoutes);
app.use("/api/v1", runnerRoutes);
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

app.listen(PORT, () => {
  console.log(`[tool-service] listening on port ${PORT}`);
});

export default app;
