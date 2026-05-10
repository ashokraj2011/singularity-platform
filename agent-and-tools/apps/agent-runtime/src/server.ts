// M11 follow-up — OTel auto-instrumentation. MUST be first.
import "./lib/observability/otel";

import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startEventDispatcher } from "./lib/eventbus/dispatcher";
import { prisma } from "./config/prisma";

// M11.a — self-register with platform-registry (no-op if env unset)
startSelfRegistration({
  service_name: "agent-runtime",
  display_name: "Singularity Agent Runtime",
  version:      "0.1.0",
  base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
  health_path:  "/health",
  auth_mode:    "bearer-iam",
  owner_team:   "agent-and-tools",
  metadata:     { layer: "domain" },
  capabilities: [
    { capability_key: "agent.templates",     description: "Agent template CRUD" },
    { capability_key: "agent.skills",        description: "Skill catalog" },
    { capability_key: "capability.bindings", description: "Agent <-> capability bindings" },
    { capability_key: "knowledge.artifacts", description: "Capability knowledge artifacts" },
  ],
}, { log: (m) => logger.info(`[platform-registry] ${m}`) });

// M11.e — event-bus dispatcher (LISTEN/NOTIFY + safety sweep)
void startEventDispatcher(prisma).catch((err) => {
  logger.warn(`[eventbus] dispatcher failed to start: ${(err as Error).message}`);
});

app.listen(env.PORT, () => {
  logger.info(`[agent-runtime] listening on port ${env.PORT}`);
});
