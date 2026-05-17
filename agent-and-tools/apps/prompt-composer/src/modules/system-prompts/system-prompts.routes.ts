/**
 * M36.4 — single-shot SystemPrompt resolver.
 *
 * For services that need ONE prompt string by key (not a layered profile).
 * Example callers: workgraph-api event-horizon, agent-service distillation,
 * tool-service summarise/extract-entities, agent-runtime summarise,
 * prompt-composer capsule compiler, audit-gov diagnose.
 *
 *   GET  /api/v1/system-prompts                — list all active prompts (admin)
 *   GET  /api/v1/system-prompts/:key           — fetch the active version for a key
 *   POST /api/v1/system-prompts/:key/render    — fetch + render with {{vars}}
 *
 * Render is a convenience: the caller can also fetch raw content and
 * substitute locally. Kept on composer so the substitution warning logic
 * lives in one place.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { render as renderMustache } from "../../shared/mustache";
import { NotFoundError } from "../../shared/errors";
import { validate } from "../../middleware/validate.middleware";
import { ok } from "../../shared/response";

export const systemPromptsRoutes = Router();

const renderSchema = z.object({
  vars: z.record(z.unknown()).optional(),
});

async function fetchActive(key: string) {
  return prisma.systemPrompt.findFirst({
    where: { key, isActive: true },
    orderBy: { version: "desc" },
  });
}

systemPromptsRoutes.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.systemPrompt.findMany({
      where: { isActive: true },
      orderBy: [{ key: "asc" }, { version: "desc" }],
      select: { id: true, key: true, version: true, modelHint: true, description: true, updatedAt: true },
    });
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
});

systemPromptsRoutes.get("/:key", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await fetchActive(req.params.key);
    if (!row) throw new NotFoundError(`No active SystemPrompt for key "${req.params.key}"`);
    return ok(res, {
      id: row.id,
      key: row.key,
      version: row.version,
      content: row.content,
      jsonSchema: row.jsonSchema,
      modelHint: row.modelHint,
    });
  } catch (err) {
    next(err);
  }
});

systemPromptsRoutes.post(
  "/:key/render",
  validate(renderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await fetchActive(req.params.key);
      if (!row) throw new NotFoundError(`No active SystemPrompt for key "${req.params.key}"`);
      const vars = (req.body?.vars ?? {}) as Record<string, unknown>;
      const rendered = renderMustache(row.content, vars);
      if (rendered.warnings.length > 0) {
        logger.debug(
          { key: row.key, version: row.version, unresolved: rendered.warnings },
          "[system-prompts] template has unresolved Mustache vars",
        );
      }
      return ok(res, {
        key: row.key,
        version: row.version,
        content: rendered.rendered,
        jsonSchema: row.jsonSchema,
        modelHint: row.modelHint,
        unresolvedVars: rendered.warnings,
      });
    } catch (err) {
      next(err);
    }
  },
);
