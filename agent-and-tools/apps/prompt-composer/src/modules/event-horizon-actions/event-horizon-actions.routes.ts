/**
 * M36.5 — EventHorizonAction catalog endpoint.
 *
 *   GET /api/v1/event-horizon-actions?surface=workflow-manager
 *
 * Returns the active actions for one SPA surface, sorted by displayOrder.
 * The SPA fires action.prompt as the LLM user message and tags the audit
 * event with action.intent.
 *
 * Surface values (seeded):
 *   workflow-manager   — workgraph-web (workgraph-studio/apps/web)
 *   capability-admin   — agent-and-tools/web
 *   uac                — UserAndCapabillity SPA
 *   portal             — singularity-portal
 */
import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { ok } from "../../shared/response";

export const eventHorizonActionsRoutes = Router();

eventHorizonActionsRoutes.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const surface = String(req.query.surface ?? "").trim();
    const where = surface ? { isActive: true, surface } : { isActive: true };
    const rows = await prisma.eventHorizonAction.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { intent: "asc" }],
      select: {
        id: true,
        surface: true,
        intent: true,
        label: true,
        prompt: true,
        displayOrder: true,
      },
    });
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
});
