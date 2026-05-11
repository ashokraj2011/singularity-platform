import { Router } from "express";
import { composeController } from "./compose.controller";
import { validate } from "../../middleware/validate.middleware";
import { composeSchema } from "./compose.schemas";
import { composeService } from "./compose.service";

export const composeRoutes = Router();

// POST /api/v1/compose-and-respond
composeRoutes.post("/", validate(composeSchema), composeController.composeAndRespond);

// M16 — debug retrieval. Returns the raw scored hits per kind for a
// (capabilityId, task) pair. Used by the SPA tuning panel.
//   POST /api/v1/compose-and-respond/debug-retrieval
//   body: { capabilityId: string; task: string }
export const composeDebugRoutes = Router();
composeDebugRoutes.post("/", async (req, res, next) => {
  try {
    const { capabilityId, task } = req.body ?? {};
    if (!capabilityId || !task) return res.status(400).json({ error: "capabilityId + task required" });
    // We need a vector; embed the task here. The service helpers expect a
    // pgvector literal already, so we duplicate that one-liner.
    const { getEmbeddingProvider, assertDimMatches, toVectorLiteral } = await import("@agentandtools/shared");
    const embedded = await getEmbeddingProvider().embed({ text: String(task).slice(0, 8_000) });
    assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
    const taskVec = toVectorLiteral(embedded.vector);
    const [knowledge, memory, code] = await Promise.all([
      composeService.semanticKnowledge(capabilityId, taskVec),
      composeService.semanticMemory(capabilityId, taskVec),
      composeService.semanticSymbols(capabilityId, taskVec),
    ]);
    res.json({
      capabilityId, task,
      provider: embedded.provider, model: embedded.model, dim: embedded.dim,
      tuning: {
        recencyBoostMax:  Number(process.env.EMBEDDING_RECENCY_BOOST ?? 0.2),
        recencyBoostDays: Number(process.env.EMBEDDING_RECENCY_DAYS ?? 30),
      },
      knowledge, memory, code,
    });
  } catch (err) { next(err); }
});
