/**
 * M36.1 — HTTP surface for stage-prompt resolution.
 *
 * Mounted at /api/v1/stage-prompts.
 *
 *   POST /api/v1/stage-prompts/resolve   { stageKey, agentRole?, vars? }
 *      → 200 { task, systemPromptAppend, promptProfileId, bindingId, stageKey, agentRole }
 *      → 404 if no binding exists
 *
 *   GET  /api/v1/stage-prompts            — list every active binding (admin)
 */
import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../../middleware/validate.middleware";
import { stagePromptsService } from "./stage-prompts.service";
import { resolveStageSchema } from "./stage-prompts.schemas";
import { ok } from "../../shared/response";

export const stagePromptsRoutes = Router();

stagePromptsRoutes.post(
  "/resolve",
  validate(resolveStageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await stagePromptsService.resolve(req.body);
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

stagePromptsRoutes.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const bindings = await stagePromptsService.list();
    return ok(res, bindings);
  } catch (err) {
    next(err);
  }
});
