import { Router } from "express";
import { agentController } from "./agent.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  createAgentTemplateSchema, listAgentTemplatesQuerySchema,
  createSkillSchema, attachSkillSchema,
  deriveAgentTemplateSchema, updateAgentTemplateSchema,
} from "./agent.schemas";

export const agentRoutes = Router();

agentRoutes.post("/templates", validate(createAgentTemplateSchema), agentController.createTemplate);
agentRoutes.get("/templates", validate(listAgentTemplatesQuerySchema, "query"), agentController.listTemplates);
agentRoutes.get("/templates/:id", agentController.getTemplate);
// M23 — derive a capability-scoped child + lock-aware patch
agentRoutes.post("/templates/:id/derive", validate(deriveAgentTemplateSchema), agentController.deriveTemplate);
agentRoutes.patch("/templates/:id", validate(updateAgentTemplateSchema), agentController.updateTemplate);
agentRoutes.post("/templates/:id/skills", validate(attachSkillSchema), agentController.attachSkill);

agentRoutes.post("/skills", validate(createSkillSchema), agentController.createSkill);
agentRoutes.get("/skills", agentController.listSkills);
