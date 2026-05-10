import { Router } from "express";
import { promptController } from "./prompt.controller";
import { validate } from "../../middleware/validate.middleware";
import { createProfileSchema, createLayerSchema, attachLayerSchema, assembleSchema } from "./prompt.schemas";

// /api/v1/prompt-profiles
export const promptProfileRoutes = Router();
promptProfileRoutes.post("/", validate(createProfileSchema), promptController.createProfile);
promptProfileRoutes.get("/", promptController.listProfiles);
promptProfileRoutes.get("/:id", promptController.getProfile);
promptProfileRoutes.post("/:profileId/layers", validate(attachLayerSchema), promptController.attachLayer);

// /api/v1/prompt-layers
export const promptLayerRoutes = Router();
promptLayerRoutes.post("/", validate(createLayerSchema), promptController.createLayer);
promptLayerRoutes.get("/", promptController.listLayers);

// /api/v1/prompt-assemblies
export const promptAssemblyRoutes = Router();
promptAssemblyRoutes.post("/", validate(assembleSchema), promptController.assemble);
promptAssemblyRoutes.get("/:id", promptController.getAssembly);
