/**
 * M21 — Audit & Governance Service entry point.
 *
 * Routes:
 *   GET  /health
 *   POST /api/v1/events                  POST /api/v1/events/batch
 *   POST /api/v1/governance/approvals    GET …/:id  POST …/:id/decide  GET .../
 *   POST /api/v1/governance/budgets      GET .../  GET .../check
 *   POST /api/v1/governance/rate-limits  GET .../  GET .../check
 *   POST /api/v1/governance/authz/decisions  GET .../authz/decisions
 *   GET  /api/v1/audit/timeline          GET /api/v1/audit/events/:id
 *   GET  /api/v1/cost/rollup             GET /api/v1/cost/by-model  GET /api/v1/cost/summary
 *
 * Singularity Engine (automated failure triage):
 *   GET  /api/v1/engine/issues           POST .../diagnose  .../resolve  .../dismiss
 *   GET  /api/v1/engine/evaluators       PATCH .../:id  POST .../run
 *   GET  /api/v1/engine/datasets         POST ...  GET .../examples  POST .../from-issue/:id
 *   GET  /api/v1/engine/stats
 */
import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { eventsRouter } from "./routes-events";
import { governanceRouter } from "./routes-governance";
import { queryRouter } from "./routes-query";
import { engineRouter } from "./engine/routes";
import { startEngineSweep, stopEngineSweep } from "./engine/sweep";
import { ensureEngineEvalTables } from "./db";

// M35.1 — production-class envs refuse to start with weak secrets.
// Mirrors @agentandtools/shared assertProductionSecret (inlined here
// because audit-governance-service is outside that workspace).
function assertProductionSecretLocal(name: string, value: string | undefined, minLength = 32): void {
  const env = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (!["production", "prod", "staging", "perf"].includes(env)) return;
  const KNOWN_BAD = new Set([
    "dev-secret-change-in-prod",
    "dev-secret-change-in-prod-min-32-chars!!",
    "changeme_dev_only_min_32_chars_long!!",
    "demo-bearer-token-must-be-min-16-chars",
    "dev-audit-gov-service-token",
    "changeme",
    "test-secret",
  ]);
  const v = value ?? "";
  const reasons: string[] = [];
  if (v.length === 0) reasons.push("unset");
  else if (v.length < minLength) reasons.push(`shorter than ${minLength} chars (got ${v.length})`);
  if (KNOWN_BAD.has(v)) reasons.push("matches a known development default");
  if (reasons.length > 0) {
    console.error(`FATAL: ${name} is unsafe for NODE_ENV=${env}: ${reasons.join("; ")}. Set ${name} to a strong random value (${minLength}+ chars) and restart.`);
    process.exit(1);
  }
}
assertProductionSecretLocal("AUDIT_GOV_SERVICE_TOKEN", process.env.AUDIT_GOV_SERVICE_TOKEN, 32);

const app = express();
const PORT = Number(process.env.PORT ?? 8500);

app.use(helmet());
// M35.3 — tighten CORS: restrict to configured origins and enable credentials
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000").split(",").map(o => o.trim());
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "audit-governance-service", timestamp: new Date().toISOString() });
});

// M28 boot-1 — strict invariants. 200 only when DB reachable + audit_governance
// schema + audit_events table present + gen_random_uuid() works. 503 + failing
// check names otherwise. The single highest-value boot check in the stack:
// without these, every fire-and-forget audit emit from cf/mcp/composer drops
// silently and no one notices for hours.
app.get("/healthz/strict", async (_req, res) => {
  const { runInvariantChecks } = await import("./healthz-strict");
  const result = await runInvariantChecks();
  res.status(result.ok ? 200 : 503).json({
    ok: result.ok,
    service: "audit-governance-service",
    checks: result.checks,
  });
});

app.use("/api/v1/events",     eventsRouter);
app.use("/api/v1/governance", governanceRouter);
app.use("/api/v1",            queryRouter);
app.use("/api/v1/engine",    engineRouter);

// Error handler — translate ZodErrors and unknowns into JSON.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "validation", details: err.flatten() });
  }
  const e = err as { status?: number; message?: string };
  // eslint-disable-next-line no-console
  console.error("[audit-gov] unhandled", err);
  res.status(e.status ?? 500).json({ error: e.message ?? "internal error" });
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[audit-gov] listening on port ${PORT}`);

  void ensureEngineEvalTables().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[audit-gov] failed to ensure eval tables", err);
  });

  // Start the Singularity Engine sweep worker.
  startEngineSweep();
});

// Graceful shutdown.
process.on("SIGTERM", () => {
  stopEngineSweep();
  server.close();
});
