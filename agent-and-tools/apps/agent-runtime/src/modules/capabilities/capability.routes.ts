import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { capabilityController } from "./capability.controller";
import { capabilityService } from "./capability.service";
import { validate } from "../../middleware/validate.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { ForbiddenError } from "../../shared/errors";
import {
  createCapabilitySchema, attachRepositorySchema, bindAgentSchema, knowledgeArtifactSchema,
  extractSymbolsSchema,
  updateRepoPollSchema, knowledgeSourceSchema, updateKnowledgeSourceSchema,
  bootstrapCapabilitySchema, reviewBootstrapSchema, syncCapabilitySchema, updateCapabilitySchema,
  learningWorkerRunSchema,
} from "./capability.schemas";

// M15 — multipart upload (knowledge artifacts). Memory storage keeps things
// simple; per-file 25 MB cap + 10-file batch cap matches the express.json
// limit on the rest of the API.
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024, files: 10 },
});

async function requireMutableCapabilityBeforeUpload(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const capability = await capabilityService.get(req.params.id);
  if (String(capability.status ?? "").toUpperCase() === "ARCHIVED") {
    throw new ForbiddenError("Capability is archived; knowledge upload is read-only.");
  }
  next();
}

export const capabilityRoutes = Router();

capabilityRoutes.use(requireAuth);

capabilityRoutes.post("/bootstrap", validate(bootstrapCapabilitySchema), capabilityController.bootstrap);
capabilityRoutes.get("/bootstrap-agent-catalog", capabilityController.bootstrapAgentCatalog);
capabilityRoutes.post("/", validate(createCapabilitySchema), capabilityController.create);
capabilityRoutes.get("/", capabilityController.list);
capabilityRoutes.get("/:id/readiness", capabilityController.readiness);
capabilityRoutes.get("/:id/grounding-status", capabilityController.groundingStatus);
capabilityRoutes.get("/:id/architecture-diagram", capabilityController.architectureDiagram);
capabilityRoutes.get("/:id", capabilityController.get);
capabilityRoutes.patch("/:id", validate(updateCapabilitySchema), capabilityController.update);
capabilityRoutes.post("/:id/archive", capabilityController.archive);
capabilityRoutes.get("/:id/bootstrap-runs/:runId", capabilityController.getBootstrapRun);
capabilityRoutes.post(
  "/:id/bootstrap-runs/:runId/review",
  validate(reviewBootstrapSchema),
  capabilityController.reviewBootstrapRun,
);
capabilityRoutes.post("/:id/sync", validate(syncCapabilitySchema), capabilityController.sync);
capabilityRoutes.post(
  "/:id/learning-worker/run",
  validate(learningWorkerRunSchema),
  capabilityController.runLearningWorker,
);

capabilityRoutes.post("/:id/repositories", validate(attachRepositorySchema), capabilityController.attachRepo);
capabilityRoutes.delete("/:id/repositories/:repoId", capabilityController.deleteRepo);

capabilityRoutes.post("/:id/agent-bindings", validate(bindAgentSchema), capabilityController.bindAgent);
capabilityRoutes.get("/:id/agent-bindings", capabilityController.listBindings);
capabilityRoutes.delete("/:id/agent-bindings/:bindingId", capabilityController.deleteBinding);

capabilityRoutes.post("/:id/knowledge-artifacts", validate(knowledgeArtifactSchema), capabilityController.addKnowledge);
capabilityRoutes.get("/:id/knowledge-artifacts", capabilityController.listKnowledge);
capabilityRoutes.delete("/:id/knowledge-artifacts/:artifactId", capabilityController.deleteKnowledge);
// M15 — multipart upload (txt/md/pdf). Server extracts text + delegates to addKnowledge.
capabilityRoutes.post(
  "/:id/knowledge-artifacts/upload",
  requireMutableCapabilityBeforeUpload,
  knowledgeUpload.array("files", 10),
  capabilityController.uploadKnowledge,
);

// M14 — code-symbol extraction. Body shape: {files:[{path, content}, ...]}
capabilityRoutes.post(
  "/:id/repositories/:repoId/extract",
  validate(extractSymbolsSchema),
  capabilityController.extractSymbols,
);

// M16 — re-embed worker. Body: {kinds?: ("knowledge"|"memory"|"code")[]}.
// Backfills embeddings for rows whose vector column is NULL (provider switch
// or M14 v0 migration).
capabilityRoutes.post("/:id/embeddings/reembed", capabilityController.reembed);

// M17 — polling config + knowledge sources.
capabilityRoutes.patch(
  "/:id/repositories/:repoId/poll",
  validate(updateRepoPollSchema),
  capabilityController.updateRepoPoll,
);
capabilityRoutes.get(
  "/:id/knowledge-sources",
  capabilityController.listKnowledgeSources,
);
capabilityRoutes.post(
  "/:id/knowledge-sources",
  validate(knowledgeSourceSchema),
  capabilityController.addKnowledgeSource,
);
capabilityRoutes.patch(
  "/:id/knowledge-sources/:sourceId",
  validate(updateKnowledgeSourceSchema),
  capabilityController.updateKnowledgeSource,
);
capabilityRoutes.delete(
  "/:id/knowledge-sources/:sourceId",
  capabilityController.deleteKnowledgeSource,
);

// M61 Wire 1 — GET CapabilityWorldModel. Returns the projected view
// that the Slice F prompt-composer renderers consume. context-fabric
// fetches this at workflow start and passes the body through to
// /api/v1/compose-and-respond as `worldModel`. 404 when not yet
// generated for the capability.
capabilityRoutes.get(
  "/:id/world-model",
  capabilityController.getWorldModel,
);

// On-demand re-distillation — refresh an existing capability's world-model
// grounding (LLM enrichment + architecture slice) without re-onboarding.
capabilityRoutes.post(
  "/:id/world-model/redistill",
  capabilityController.redistillWorldModel,
);

// M61 Slice E — repo fingerprint drift detector. Body:
//   { fingerprint: string, hashedBuildFiles?: string[], topLevelEntries?: string[] }
// Idempotent: callers may safely re-POST every workflow start.
capabilityRoutes.post(
  "/:id/world-model/fingerprint",
  capabilityController.checkWorldModelFingerprint,
);

// M61 Wire B P2 — AST index callback. Body:
//   { astIndexFiles: number }
// Fired by mcp-server after it builds (or refreshes) the workspace's
// tree-sitter index. Stamps astIndexedAt + astIndexFiles on the
// CapabilityWorldModel row. Idempotent.
capabilityRoutes.post(
  "/:id/world-model/ast-index-built",
  capabilityController.reportAstIndexBuilt,
);

// M61 Wire D — Verify-now probe. Body:
//   { cmd: string, cwd?: string }
// Spawns the command in an isolated tmp dir with a 10s timeout.
// Returns { exitCode, signal, timedOut, durationMs, stdout, stderr, … }.
// NOT a sandboxed test runner — just syntax-level verification.
capabilityRoutes.post(
  "/:id/world-model/probe-command",
  capabilityController.probeWorldModelCommand,
);
