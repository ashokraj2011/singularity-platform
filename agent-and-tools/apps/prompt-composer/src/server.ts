import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startSelfRegistration } from "./lib/platform-registry/register";

// M11.a — self-register with platform-registry (no-op if env unset)
startSelfRegistration({
  service_name: "prompt-composer",
  display_name: "Singularity Prompt Composer",
  version:      "0.1.0",
  base_url:     process.env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
  health_path:  "/health",
  auth_mode:    "bearer-iam",
  owner_team:   "agent-and-tools",
  metadata:     { layer: "composition" },
  capabilities: [
    { capability_key: "prompt.profiles",   description: "Prompt profile CRUD + versioning" },
    { capability_key: "prompt.layers",     description: "Layered prompt composition (PLATFORM/TENANT/...)" },
    { capability_key: "prompt.assemble",   description: "Assemble + persist a prompt assembly with provenance" },
    { capability_key: "prompt.compose-and-respond", description: "Full pipeline: compose -> context-fabric -> response" },
  ],
}, { log: (m) => logger.info(`[platform-registry] ${m}`) });

app.listen(env.PORT, () => {
  logger.info(`[prompt-composer] listening on port ${env.PORT}`);
});
