import { Router } from "express";
import multer from "multer";
import { capabilityController } from "./capability.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  createCapabilitySchema, attachRepositorySchema, bindAgentSchema, knowledgeArtifactSchema,
  extractSymbolsSchema,
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

// M14 — code-symbol extraction (regex-based v0). Body shape: {files:[{path, content}, ...]}
capabilityRoutes.post(
  "/:id/repositories/:repoId/extract",
  validate(extractSymbolsSchema),
  capabilityController.extractSymbols,
);
