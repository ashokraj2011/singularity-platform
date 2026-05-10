import { Router } from "express";
import { capabilityController } from "./capability.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  createCapabilitySchema, attachRepositorySchema, bindAgentSchema, knowledgeArtifactSchema,
} from "./capability.schemas";

export const capabilityRoutes = Router();

capabilityRoutes.post("/", validate(createCapabilitySchema), capabilityController.create);
capabilityRoutes.get("/", capabilityController.list);
capabilityRoutes.get("/:id", capabilityController.get);

capabilityRoutes.post("/:id/repositories", validate(attachRepositorySchema), capabilityController.attachRepo);

capabilityRoutes.post("/:id/agent-bindings", validate(bindAgentSchema), capabilityController.bindAgent);
capabilityRoutes.get("/:id/agent-bindings", capabilityController.listBindings);

capabilityRoutes.post("/:id/knowledge-artifacts", validate(knowledgeArtifactSchema), capabilityController.addKnowledge);
capabilityRoutes.get("/:id/knowledge-artifacts", capabilityController.listKnowledge);
