import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { requestIdMiddleware } from "./middleware/request-id";
import { bearerAuth, requireMcpScope } from "./middleware/auth";
import { errorMiddleware } from "./middleware/error";
import { invokeRouter } from "./mcp/invoke";
import { tokensRouter } from "./mcp/tokens";
import { toolsRouter } from "./mcp/tools";
import { workRouter } from "./mcp/work";
import { resourcesRouter } from "./mcp/resources";
import { eventsRouter } from "./mcp/events";
import { discoveryRouter } from "./mcp/discovery";
import { buildCodeContextPackage } from "./mcp/code-context";
import { listConfiguredProviders, ensureFreshGatewayStatus, llmEmbed } from "./llm/client";
import { modelCatalogResponse } from "./llm/model-catalog";
import { configuredDefaultModel, configuredDefaultProvider, providerConfigSummary } from "./llm/provider-config";
import { runInvariantChecks } from "./healthz-strict";
import { AppError } from "./shared/errors";

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
app.get("/llm/providers", bearerAuth, async (_req, res) => {
  // Bug-fix (M-fix) — refresh the gateway-provider cache before responding
  // so the Operations Portal sees current key state, not boot-time empty cache.
  await ensureFreshGatewayStatus();
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

app.get("/llm/models", bearerAuth, async (_req, res) => {
  // Bug-fix (M-fix) — same refresh path as /llm/providers; the model
  // catalog's `ready` per row reads from the same cachedGatewayStatus.
  await ensureFreshGatewayStatus();
  res.json({
    success: true,
    data: modelCatalogResponse(),
    requestId: res.locals.requestId,
  });
});

// Everything under /mcp/* requires a valid bearer token.
app.use("/mcp", bearerAuth);
app.use("/mcp", tokensRouter);
app.use("/mcp/invoke", requireMcpScope("invoke"));
app.use("/mcp/resume", requireMcpScope("invoke"));
app.use("/mcp/tools/list", requireMcpScope("tools:list"));
app.use("/mcp/tools/call", requireMcpScope("tools:call"));
app.use("/mcp/resources", requireMcpScope("resources:read"));
app.use("/mcp/events", requireMcpScope("events:read"));
app.use("/mcp", discoveryRouter);
app.post("/mcp/embed", async (req, res) => {
  const parsed = z.object({
    modelAlias: z.string().min(1).optional(),
    input: z.array(z.string()).min(1, "input cannot be empty"),
    runContext: z.object({
      traceId: z.string().optional(),
      capabilityId: z.string().optional(),
    }).default({}),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/embed payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  // Graceful degradation: the default model alias resolves to Anthropic, which
  // has no embeddings API — the gateway returns 400 in that case. Rather than
  // letting that bubble up as a 500 (and crash whatever stage initiated the
  // embed), return an empty-embeddings response with a clear `unavailable`
  // marker so the caller can detect and skip the feature. Real failures (auth,
  // timeout) still propagate.
  try {
    const result = await llmEmbed({
      ...(parsed.data.modelAlias ? { model_alias: parsed.data.modelAlias } : {}),
      input: parsed.data.input,
      trace_id: parsed.data.runContext.traceId,
      capability_id: parsed.data.runContext.capabilityId,
    });
    res.json({ success: true, data: result, requestId: res.locals.requestId });
  } catch (err) {
    const message = (err as Error).message ?? "";
    const provider400 =
      message.includes("LLM_GATEWAY_EMBEDDINGS_UPSTREAM 400") ||
      message.includes("not supported for provider") ||
      message.includes("embeddings not supported");
    if (!provider400) throw err;
    res.json({
      success: true,
      data: {
        unavailable: true,
        reason: message.slice(0, 240),
        embeddings: parsed.data.input.map(() => [] as number[]),
        dim: 0,
        input_tokens: 0,
        latency_ms: 0,
        model_alias: parsed.data.modelAlias,
      },
      requestId: res.locals.requestId,
    });
  }
});
// M52 — Code Context Budgeter. Context Fabric calls this BEFORE prompt
// composition for Developer-style stages. Returns a token-budgeted
// package of AST slices that Prompt Composer renders into CODE_* layers.
// NOT an agent-callable tool — the resulting prompt lands at step 0 of
// the ReAct loop, fully formed.
app.post("/mcp/code-context/build", async (req, res) => {
  const parsed = z.object({
    task_text: z.string().min(1, "task_text is required"),
    target_hints: z.array(z.string()).optional(),
    max_token_budget: z.number().int().positive().max(50_000).optional(),
    max_dependency_depth: z.number().int().min(0).max(5).optional(),
    include_tests: z.boolean().optional(),
    trace_id: z.string().optional(),
    capability_id: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    throw new AppError("invalid /mcp/code-context/build payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }
  const pkg = await buildCodeContextPackage(parsed.data);
  res.json({ success: true, data: pkg, requestId: res.locals.requestId });
});
app.use("/mcp", invokeRouter);
app.use("/mcp", toolsRouter);
// M37.1 — purpose-built workflow-branch operations. Replaces the bypass
// path where GitPushExecutor used to POST a hardcoded tool name to the
// generic /mcp/tools/call endpoint.
app.use("/mcp", workRouter);
app.use("/mcp", resourcesRouter);
app.use("/mcp", eventsRouter);

app.use(errorMiddleware);
