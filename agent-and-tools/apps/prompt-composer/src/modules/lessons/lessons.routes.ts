/**
 * M38 — HTTP surface for the lessons-learned catalog.
 *
 * Mounted at /api/v1/lessons.
 *
 *   POST /api/v1/lessons              — create a lesson (audit-gov calls this)
 *   GET  /api/v1/lessons              — list active lessons (admin; ?capabilityId=...)
 *   PATCH /api/v1/lessons/:id/deactivate — admin override (e.g. wrong rule)
 */
import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../../middleware/validate.middleware";
import { lessonsService } from "./lessons.service";
import { createLessonSchema, deactivateLessonSchema } from "./lessons.schemas";
import { ok } from "../../shared/response";

export const lessonsRoutes = Router();

lessonsRoutes.post("/", validate(createLessonSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const created = await lessonsService.create(req.body);
    return ok(res, created, 201);
  } catch (err) {
    next(err);
  }
});

lessonsRoutes.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const capabilityId = typeof req.query.capabilityId === "string" ? req.query.capabilityId : undefined;
    const rows = await lessonsService.list(capabilityId);
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
});

lessonsRoutes.patch(
  "/:id/deactivate",
  validate(deactivateLessonSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await lessonsService.deactivate(req.params.id, req.body?.reason, req.body?.supersededBy);
      return ok(res, { id: req.params.id, isActive: false });
    } catch (err) {
      next(err);
    }
  },
);
