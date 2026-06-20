import { Router } from "express";
import multer from "multer";
import { agentController } from "./agent.controller";
import { validate } from "../../middleware/validate.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  createAgentTemplateSchema, listAgentTemplatesQuerySchema,
  createSkillSchema, attachSkillSchema,
  deriveAgentTemplateSchema, restoreAgentTemplateVersionSchema, updateAgentTemplateSchema,
} from "./agent.schemas";

export const agentRoutes = Router();

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

agentRoutes.use(requireAuth);

agentRoutes.post("/profiles", requireAuth, profileUpload.array("files", 10), agentController.createProfile);
agentRoutes.get("/profiles/:id/sources", requireAuth, agentController.getProfileSources);
agentRoutes.post("/profiles/:id/resolve", requireAuth, agentController.resolveProfile);
agentRoutes.post("/skill-sources/preview", requireAuth, profileUpload.single("file"), agentController.previewSkillSource);

agentRoutes.post("/templates", requireAuth, validate(createAgentTemplateSchema), agentController.createTemplate);
agentRoutes.get("/templates", validate(listAgentTemplatesQuerySchema, "query"), agentController.listTemplates);
agentRoutes.get("/templates/:id", agentController.getTemplate);
// M23 — derive a capability-scoped child + lock-aware patch
agentRoutes.post("/templates/:id/derive", requireAuth, validate(deriveAgentTemplateSchema), agentController.deriveTemplate);
agentRoutes.patch("/templates/:id", requireAuth, validate(updateAgentTemplateSchema), agentController.updateTemplate);
agentRoutes.get("/templates/:id/versions", agentController.listTemplateVersions);
agentRoutes.post("/templates/:id/versions/:version/restore", requireAuth, validate(restoreAgentTemplateVersionSchema), agentController.restoreTemplateVersion);
agentRoutes.post("/templates/:id/skills", requireAuth, validate(attachSkillSchema), agentController.attachSkill);

agentRoutes.post("/skills", requireAuth, validate(createSkillSchema), agentController.createSkill);
agentRoutes.get("/skills", agentController.listSkills);
