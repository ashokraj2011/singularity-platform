import { Router } from "express";
import { agentController } from "./agent.controller";
import { validate } from "../../middleware/validate.middleware";
import {
  createAgentTemplateSchema, listAgentTemplatesQuerySchema,
  createSkillSchema, attachSkillSchema,
} from "./agent.schemas";

export const agentRoutes = Router();

agentRoutes.post("/templates", validate(createAgentTemplateSchema), agentController.createTemplate);
agentRoutes.get("/templates", validate(listAgentTemplatesQuerySchema, "query"), agentController.listTemplates);
agentRoutes.get("/templates/:id", agentController.getTemplate);
agentRoutes.post("/templates/:id/skills", validate(attachSkillSchema), agentController.attachSkill);

agentRoutes.post("/skills", validate(createSkillSchema), agentController.createSkill);
agentRoutes.get("/skills", agentController.listSkills);
