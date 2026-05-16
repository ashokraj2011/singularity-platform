// M11 follow-up — OTel auto-instrumentation. MUST be first.
import "./lib/observability/otel";

import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { agentRoutes } from "./routes/agents";
import { versionRoutes } from "./routes/versions";
import { learningRoutes } from "./routes/learning";
import { runtimeRoutes } from "./routes/runtime";
import { errorHandler } from "./middleware/errorHandler";
import { optionalAuth, requireAuth } from "./middleware/auth";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startEventDispatcher } from "./lib/eventbus/dispatcher";
import { eventSubscriptionsRouter } from "./lib/eventbus/routes";

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3001;

function authOptional(): boolean {
  return process.env.AUTH_OPTIONAL === "true";
}

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "singularity-agent-service", timestamp: new Date().toISOString() });
});

app.use(authOptional() ? optionalAuth : requireAuth);

app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/agents", versionRoutes);
app.use("/api/v1/agents", learningRoutes);
app.use("/api/v1", runtimeRoutes);
// M11.e — event-bus subscription registry
app.use("/api/v1/events/subscriptions", eventSubscriptionsRouter);

app.use(errorHandler);

// M11.e — start dispatcher
void startEventDispatcher().catch((err) => {
  console.warn(`[eventbus] dispatcher failed to start: ${(err as Error).message}`);
});

// M11.a — self-register with platform-registry (no-op if env unset)
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

app.listen(PORT, () => {
  console.log(`[agent-service] listening on port ${PORT}`);
});

export default app;
