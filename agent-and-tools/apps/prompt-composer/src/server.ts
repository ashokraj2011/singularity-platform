import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startSelfRegistration } from "./lib/platform-registry/register";
import { startCapsuleGc, startCapsuleFailureAlerts } from "./modules/compose/capsule-gc";

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

// M25.5 C9 — capsule GC sweeper. Drops `expiresAt < now()` rows + cold
// `hitCount=0` rows older than COLD_DAYS so storage stays bounded as task
// signatures churn. interval/TTL configurable via CAPSULE_GC_INTERVAL_MS,
// CAPSULE_TTL_DAYS, CAPSULE_COLD_DAYS. No-ops in test envs that mock Prisma.
startCapsuleGc();

// M25.5 C5 — periodic check of LLM-compile failure rate; emits
// `compose.capsule.compile.alert` to audit-gov when > CAPSULE_FAILURE_ALERT_RATE
// (default 5%) over CAPSULE_FAILURE_WINDOW_MS (default 60min). Without
// this an audit-gov outage or model regression silently leaves capsules
// stuck on the RAW fallback indefinitely.
startCapsuleFailureAlerts();

app.listen(env.PORT, () => {
  logger.info(`[prompt-composer] listening on port ${env.PORT}`);
});
