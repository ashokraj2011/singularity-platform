/**
 * M40 — HTTP surface for ImmutableContract.
 *
 *   POST /api/v1/contracts                      — mint a new contract
 *   GET  /api/v1/contracts/:id                  — fetch the full bundle (replay)
 *   GET  /api/v1/contracts?agentTemplateId=...  — admin list
 *   GET  /api/v1/contracts/by-hash/:bundleHash  — lookup by hash
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.middleware";
import { contractsService } from "./contracts.service";
import { ok } from "../../shared/response";
import { NotFoundError } from "../../shared/errors";

export const contractsRoutes = Router();

const mintSchema = z.object({
  agentTemplateId:      z.string().uuid(),
  agentTemplateVersion: z.number().int().positive(),
  capabilityId:         z.string().optional(),
  modelAlias:           z.string().optional(),
  capturedBy:           z.string().optional(),
  capturedFrom:         z.string().optional(),
  consumableId:         z.string().optional(),
});

contractsRoutes.post("/", validate(mintSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await contractsService.mint(req.body);
    return ok(res, result, 201);
  } catch (err) {
    next(err);
  }
});

contractsRoutes.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentTemplateId = typeof req.query.agentTemplateId === "string" ? req.query.agentTemplateId : "";
    if (!agentTemplateId) {
      return res.status(400).json({ success: false, error: "agentTemplateId query param required" });
    }
    const rows = await contractsService.listForAgent(agentTemplateId);
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
});

contractsRoutes.get("/by-hash/:bundleHash", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await contractsService.getByHash(req.params.bundleHash);
    if (!row) throw new NotFoundError(`ImmutableContract with bundleHash="${req.params.bundleHash}" not found`);
    return ok(res, row);
  } catch (err) {
    next(err);
  }
});

contractsRoutes.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await contractsService.get(req.params.id);
    if (!row) throw new NotFoundError(`ImmutableContract ${req.params.id} not found`);
    return ok(res, row);
  } catch (err) {
    next(err);
  }
});
