import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { errorMiddleware } from "./middleware/error.middleware";
import { requestIdMiddleware } from "./middleware/request-id.middleware";
import { optionalAuth, requireAuth } from "./middleware/auth.middleware";
import { promptProfileRoutes, promptLayerRoutes, promptAssemblyRoutes } from "./modules/prompts/prompt.routes";
import { composeRoutes, composeDebugRoutes } from "./modules/compose/compose.routes";
import { compiledContextRoutes } from "./modules/compose/compiled-context.routes";
import { stagePromptsRoutes } from "./modules/stage-prompts/stage-prompts.routes";
import { systemPromptsRoutes } from "./modules/system-prompts/system-prompts.routes";
import { eventHorizonActionsRoutes } from "./modules/event-horizon-actions/event-horizon-actions.routes";
import { lessonsRoutes } from "./modules/lessons/lessons.routes";
import { runInvariantChecks } from "./healthz-strict";
import { env } from "./config/env";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestIdMiddleware);

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: { status: "ok", service: "singularity-prompt-composer", timestamp: new Date().toISOString() },
    error: null,
    requestId: res.locals.requestId,
  });
});

// M28 boot-1 — strict invariants. 200 only when DB reachable, pgvector loaded,
// CapabilityCompiledContext table present, and PromptAssembly.traceId column
// exists. 503 + failing check names otherwise.
app.get("/healthz/strict", async (_req, res) => {
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    success: result.ok,
    data: { ok: result.ok, service: "singularity-prompt-composer", checks: result.checks },
    error: null,
    requestId: res.locals.requestId,
  });
});

app.use(env.AUTH_OPTIONAL ? optionalAuth : requireAuth);

app.use("/api/v1/prompt-profiles", promptProfileRoutes);
app.use("/api/v1/prompt-layers", promptLayerRoutes);
app.use("/api/v1/prompt-assemblies", promptAssemblyRoutes);
app.use("/api/v1/compose-and-respond", composeRoutes);
app.use("/api/v1/compose-and-respond/debug-retrieval", composeDebugRoutes);
// M25.5 C8 — operator audit hatch for compiled-context capsules.
app.use("/api/v1/compiled-contexts", compiledContextRoutes);
// M36.1 — stage-prompt resolver. workgraph-api blueprint runner POSTs to
// /api/v1/stage-prompts/resolve so prompt text no longer lives in TS source.
app.use("/api/v1/stage-prompts", stagePromptsRoutes);
// M36.4 — single-shot SystemPrompt store. For services that need a single
// named prompt (event-horizon, distillation, summarisation, capsule
// compiler, audit-gov diagnose), not a layered agent assembly.
app.use("/api/v1/system-prompts", systemPromptsRoutes);
// M36.5 — EventHorizon action catalog. The "quick action" buttons in the
// floating assistant chip on every SPA come from this endpoint, scoped by
// surface (workflow-manager / capability-admin / uac / portal).
app.use("/api/v1/event-horizon-actions", eventHorizonActionsRoutes);
// M38 — Lessons-learned catalog. audit-gov's Singularity Engine POSTs here
// when a confirmed-resolved failure cluster yields a 2-sentence rule, and
// compose.service pulls top-K similar lessons in as GLOBAL_LESSON layers
// at assembly time.
app.use("/api/v1/lessons", lessonsRoutes);

app.use(errorMiddleware);
