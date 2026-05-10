import { Router } from "express";
import { executionController } from "./execution.controller";
import { validate } from "../../middleware/validate.middleware";
import { createExecutionSchema, startExecutionSchema } from "./execution.schemas";

export const executionRoutes = Router();

executionRoutes.post("/", validate(createExecutionSchema), executionController.create);
executionRoutes.get("/", executionController.list);
executionRoutes.get("/:id", executionController.get);
executionRoutes.post("/:id/start", validate(startExecutionSchema), executionController.start);
executionRoutes.get("/:id/receipt", executionController.getReceipt);
