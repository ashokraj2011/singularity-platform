import { Router } from "express";
import { agentController } from "./agent.controller";
import { validate } from "../../middleware/validate.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  createAgentTemplateSchema, listAgentTemplatesQuerySchema,
  createSkillSchema, attachSkillSchema,
  deriveAgentTemplateSchema, updateAgentTemplateSchema,
} from "./agent.schemas";

export const agentRoutes = Router();

agentRoutes.post("/templates", requireAuth, validate(createAgentTemplateSchema), agentController.createTemplate);
agentRoutes.get("/templates", validate(listAgentTemplatesQuerySchema, "query"), agentController.listTemplates);
agentRoutes.get("/templates/:id", agentController.getTemplate);
// M23 — derive a capability-scoped child + lock-aware patch
agentRoutes.post("/templates/:id/derive", requireAuth, validate(deriveAgentTemplateSchema), agentController.deriveTemplate);
agentRoutes.patch("/templates/:id", requireAuth, validate(updateAgentTemplateSchema), agentController.updateTemplate);
agentRoutes.post("/templates/:id/skills", requireAuth, validate(attachSkillSchema), agentController.attachSkill);

agentRoutes.post("/skills", requireAuth, validate(createSkillSchema), agentController.createSkill);
agentRoutes.get("/skills", agentController.listSkills);
