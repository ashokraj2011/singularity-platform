import { Router } from "express";
import { promptController } from "./prompt.controller";
import { validate } from "../../middleware/validate.middleware";
import { createProfileSchema, createLayerSchema, attachLayerSchema, assembleSchema } from "./prompt.schemas";

export const promptRoutes = Router();

promptRoutes.post("/profiles", validate(createProfileSchema), promptController.createProfile);
promptRoutes.get("/profiles", promptController.listProfiles);
promptRoutes.get("/profiles/:id", promptController.getProfile);
promptRoutes.post("/profiles/:profileId/layers", validate(attachLayerSchema), promptController.attachLayer);

promptRoutes.post("/layers", validate(createLayerSchema), promptController.createLayer);
promptRoutes.get("/layers", promptController.listLayers);

promptRoutes.post("/assemblies", validate(assembleSchema), promptController.assemble);
promptRoutes.get("/assemblies/:id", promptController.getAssembly);
