import { Router } from "express";
import multer from "multer";
import { capabilityController } from "./capability.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  createCapabilitySchema, attachRepositorySchema, bindAgentSchema, knowledgeArtifactSchema,
  extractSymbolsSchema,
  updateRepoPollSchema, knowledgeSourceSchema, updateKnowledgeSourceSchema,
} from "./capability.schemas";

// M15 — multipart upload (knowledge artifacts). Memory storage keeps things
// simple; per-file 25 MB cap + 10-file batch cap matches the express.json
// limit on the rest of the API.
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024, files: 10 },
});

export const capabilityRoutes = Router();

capabilityRoutes.post("/", validate(createCapabilitySchema), capabilityController.create);
capabilityRoutes.get("/", capabilityController.list);
capabilityRoutes.get("/:id", capabilityController.get);

capabilityRoutes.post("/:id/repositories", validate(attachRepositorySchema), capabilityController.attachRepo);

capabilityRoutes.post("/:id/agent-bindings", validate(bindAgentSchema), capabilityController.bindAgent);
capabilityRoutes.get("/:id/agent-bindings", capabilityController.listBindings);

capabilityRoutes.post("/:id/knowledge-artifacts", validate(knowledgeArtifactSchema), capabilityController.addKnowledge);
capabilityRoutes.get("/:id/knowledge-artifacts", capabilityController.listKnowledge);
// M15 — multipart upload (txt/md/pdf). Server extracts text + delegates to addKnowledge.
capabilityRoutes.post(
  "/:id/knowledge-artifacts/upload",
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
