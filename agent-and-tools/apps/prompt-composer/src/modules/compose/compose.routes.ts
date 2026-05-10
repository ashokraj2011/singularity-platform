import { Router } from "express";
import { composeController } from "./compose.controller";
import { validate } from "../../middleware/validate.middleware";
import { composeSchema } from "./compose.schemas";

export const composeRoutes = Router();

// POST /api/v1/compose-and-respond
composeRoutes.post("/", validate(composeSchema), composeController.composeAndRespond);
