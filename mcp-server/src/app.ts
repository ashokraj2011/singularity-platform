import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { requestIdMiddleware } from "./middleware/request-id";
import { bearerAuth } from "./middleware/auth";
import { errorMiddleware } from "./middleware/error";
import { invokeRouter } from "./mcp/invoke";
import { toolsRouter } from "./mcp/tools";
import { resourcesRouter } from "./mcp/resources";
import { eventsRouter } from "./mcp/events";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestIdMiddleware);

// Public health (unauthenticated) so context-fabric can probe it during
// IAM's POST /mcp-servers/{id}/test without holding the bearer token.
app.get("/health", (_req, res) => {
  res.json({
    success: true,
    data: {
      status: "ok",
      service: "singularity-mcp-server",
      version: "0.1.0",
      provider: config.LLM_PROVIDER,
      model: config.LLM_MODEL,
      timestamp: new Date().toISOString(),
    },
    requestId: res.locals.requestId,
  });
});

// Everything under /mcp/* requires a valid bearer token.
app.use("/mcp", bearerAuth);
app.use("/mcp", invokeRouter);
app.use("/mcp", toolsRouter);
app.use("/mcp", resourcesRouter);
app.use("/mcp", eventsRouter);

app.use(errorMiddleware);
