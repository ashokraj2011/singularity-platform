import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { errorMiddleware } from "./middleware/error.middleware";
import { requestIdMiddleware } from "./middleware/request-id.middleware";
import { optionalAuth } from "./middleware/auth.middleware";
import { promptProfileRoutes, promptLayerRoutes, promptAssemblyRoutes } from "./modules/prompts/prompt.routes";
import { composeRoutes, composeDebugRoutes } from "./modules/compose/compose.routes";
import { compiledContextRoutes } from "./modules/compose/compiled-context.routes";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestIdMiddleware);
app.use(optionalAuth);

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: { status: "ok", service: "singularity-prompt-composer", timestamp: new Date().toISOString() },
    error: null,
    requestId: res.locals.requestId,
  });
});

app.use("/api/v1/prompt-profiles", promptProfileRoutes);
app.use("/api/v1/prompt-layers", promptLayerRoutes);
app.use("/api/v1/prompt-assemblies", promptAssemblyRoutes);
app.use("/api/v1/compose-and-respond", composeRoutes);
app.use("/api/v1/compose-and-respond/debug-retrieval", composeDebugRoutes);
// M25.5 C8 — operator audit hatch for compiled-context capsules.
app.use("/api/v1/compiled-contexts", compiledContextRoutes);

app.use(errorMiddleware);
