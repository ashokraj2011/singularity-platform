import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { requestIdMiddleware } from "./middleware/request-id";
import { bearerAuth } from "./middleware/auth";
import { errorMiddleware } from "./middleware/error";
import { invokeRouter } from "./mcp/invoke";
import { toolsRouter } from "./mcp/tools";
import { resourcesRouter } from "./mcp/resources";
import { eventsRouter } from "./mcp/events";
import { listConfiguredProviders } from "./llm/client";
import { modelCatalogResponse } from "./llm/model-catalog";
import { configuredDefaultModel, configuredDefaultProvider, providerConfigSummary } from "./llm/provider-config";
import { runInvariantChecks } from "./healthz-strict";

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
      provider: configuredDefaultProvider(),
      model: configuredDefaultModel(),
      timestamp: new Date().toISOString(),
    },
    requestId: res.locals.requestId,
  });
});

// M28 boot-1 — strict health invariants. Returns 200 only when every declared
// invariant passes; 503 with the failing check names otherwise.  Used by:
//   - bin/demo-up.sh as the boot-time gate
//   - CI compose smoke for misconfig regression catch
//   - operators as a first-line diagnostic
// Unauthenticated by design — operators must be able to call it without
// holding the bearer token (e.g. when the bearer is what's misconfigured).
app.get("/healthz/strict", async (_req, res) => {
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    success: result.ok,
    data: { ok: result.ok, service: "singularity-mcp-server", checks: result.checks },
    requestId: res.locals.requestId,
  });
});

// M11 follow-up — operators can verify which providers are configured
// (without any key material being returned). Protected because model/provider
// posture is operational metadata; keep only health endpoints public.
app.get("/llm/providers", bearerAuth, (_req, res) => {
  res.json({
    success: true,
    data: {
      default_provider: configuredDefaultProvider(),
      default_model:    configuredDefaultModel(),
      provider_config:  providerConfigSummary(),
      providers:        listConfiguredProviders(),
    },
    requestId: res.locals.requestId,
  });
});

app.get("/llm/models", bearerAuth, (_req, res) => {
  res.json({
    success: true,
    data: modelCatalogResponse(),
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
