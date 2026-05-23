/**
 * M71 — HTTP surface for stage-policy resolution + admin upsert.
 *
 * Mounted at /api/v1/stage-policies.
 *
 *   POST /api/v1/stage-policies/resolve  { stageKey, agentRole?, phase? }
 *      → 200 { policyId, phases: [...], approvalModel, limits, ... }
 *      → 404 if no StagePolicy exists for the stage+role
 *
 *   POST /api/v1/stage-policies           — admin upsert (atomic replace of phase rows)
 *      → 200 { policyId, ... }  same shape as resolve
 *
 *   GET  /api/v1/stage-policies            — list every ACTIVE policy summary
 *
 * context-fabric calls /resolve once per session and caches the result; the
 * admin POST is for the (future) policy editor UI.
 */
import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../../middleware/validate.middleware";
import { stagePoliciesService } from "./stage-policies.service";
import {
  resolveStagePolicySchema,
  upsertStagePolicySchema,
} from "./stage-policies.schemas";
import { ok } from "../../shared/response";

export const stagePoliciesRoutes = Router();

stagePoliciesRoutes.post(
  "/resolve",
  validate(resolveStagePolicySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await stagePoliciesService.resolve(req.body);
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

stagePoliciesRoutes.post(
  "/",
  validate(upsertStagePolicySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await stagePoliciesService.upsert(req.body);
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

stagePoliciesRoutes.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = await stagePoliciesService.list();
    return ok(res, policies);
  } catch (err) {
    next(err);
  }
});
