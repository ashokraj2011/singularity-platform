import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startSelfRegistration } from "./lib/platform-registry/register";

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

app.listen(env.PORT, () => {
  logger.info(`[agent-runtime] listening on port ${env.PORT}`);
});
