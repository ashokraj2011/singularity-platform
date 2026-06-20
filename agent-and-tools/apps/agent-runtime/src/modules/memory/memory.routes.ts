import { Router } from "express";
import { memoryController } from "./memory.controller";
import { validate } from "../../middleware/validate.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { storeExecutionMemorySchema, promoteSchema, reviewSchema } from "./memory.schemas";

export const memoryRoutes = Router();

memoryRoutes.use(requireAuth);

memoryRoutes.post("/execution", validate(storeExecutionMemorySchema), memoryController.storeExecution);
memoryRoutes.get("/execution", memoryController.listExecution);
memoryRoutes.post("/execution/:id/review", validate(reviewSchema), memoryController.review);

memoryRoutes.post("/distilled/promote", validate(promoteSchema), memoryController.promote);
memoryRoutes.get("/distilled", memoryController.listDistilled);
