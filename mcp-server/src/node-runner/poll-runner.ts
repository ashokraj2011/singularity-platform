/**
 * Workflow poll-runner — a first-class runner for non-SERVER nodes.
 *
 * A standalone process (not the dial-in bridge) that consumes the workgraph-api
 * pending-execution queue for a given execution location and runs the nodes locally:
 *
 *   loop: GET  /pending-executions/poll?location=<LOC>
 *         POST /pending-executions/:id/claim      → { claimToken }   (409 = lost)
 *         runNode(...)                            → result | error
 *         POST /pending-executions/:id/complete   { claimToken, result | error }
 *
 * The claim/complete API is the #382-hardened one: the claim is an atomic single-
 * winner and complete is gated by the returned claimToken, so multiple runners can
 * poll the same queue safely. This makes CLIENT/EDGE/EXTERNAL mean something distinct
 * from SERVER without touching the workflow engine.
 *
 * Run it with its own env (shares the mcp-server sandbox for RUN_PYTHON):
 *   WORKGRAPH_API_URL   base URL of workgraph-api (e.g. http://localhost:8080)
 *   RUNNER_AUTH_TOKEN   bearer token authorized to poll/claim/complete
 *   RUNNER_TENANT_ID    X-Tenant-Id (required under strict tenant isolation)
 *   RUNNER_LOCATION     CLIENT | EDGE | EXTERNAL (default EDGE)
 *   RUNNER_POLL_INTERVAL_MS   (default 3000)
 *   RUNNER_MAX_CONCURRENCY    (default 2)
 *   RUNNER_HTTP_TIMEOUT_MS    (default 30000)
 */
import { runNode } from "./run-node";

type RunnerConfig = {
  apiBase: string;
  authToken: string;
  tenantId?: string;
  location: string;
  pollIntervalMs: number;
  maxConcurrency: number;
  httpTimeoutMs: number;
};

type PendingRow = {
  id: string;
  nodeId: string;
  instanceId: string;
  attempt?: number;
  location: string;
  payload?: Record<string, unknown>;
  node?: { nodeType?: string; label?: string; config?: Record<string, unknown> };
};

function log(msg: string, extra?: Record<string, unknown>): void {
  // Plain stdout — a runner is a headless process; keep logs greppable.
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[poll-runner] ${msg}${suffix}`);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export function loadRunnerConfig(): RunnerConfig {
  const apiBase = (process.env.WORKGRAPH_API_URL ?? "").replace(/\/$/, "");
  if (!apiBase) throw new Error("WORKGRAPH_API_URL is required to run the poll-runner");
  const authToken = process.env.RUNNER_AUTH_TOKEN ?? "";
  if (!authToken) throw new Error("RUNNER_AUTH_TOKEN is required to run the poll-runner");
  const location = (process.env.RUNNER_LOCATION ?? "EDGE").trim().toUpperCase();
  if (!["CLIENT", "EDGE", "EXTERNAL"].includes(location)) {
    throw new Error(`RUNNER_LOCATION must be CLIENT | EDGE | EXTERNAL (got '${location}')`);
  }
  return {
    apiBase,
    authToken,
    tenantId: process.env.RUNNER_TENANT_ID?.trim() || undefined,
    location,
    pollIntervalMs: intEnv("RUNNER_POLL_INTERVAL_MS", 3_000, 250, 60_000),
    maxConcurrency: intEnv("RUNNER_MAX_CONCURRENCY", 2, 1, 16),
    httpTimeoutMs: intEnv("RUNNER_HTTP_TIMEOUT_MS", 30_000, 1_000, 600_000),
  };
}

function headers(cfg: RunnerConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.authToken}`,
    ...(cfg.tenantId ? { "x-tenant-id": cfg.tenantId } : {}),
  };
}

async function httpJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let body: unknown = undefined;
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function poll(cfg: RunnerConfig): Promise<PendingRow[]> {
  const url = `${cfg.apiBase}/api/workflow-instances/pending-executions/poll?location=${encodeURIComponent(cfg.location)}`;
  const { status, body } = await httpJson(url, { method: "GET", headers: headers(cfg) }, cfg.httpTimeoutMs);
  if (status !== 200) throw new Error(`poll failed (HTTP ${status})`);
  return Array.isArray(body) ? (body as PendingRow[]) : [];
}

async function claim(cfg: RunnerConfig, id: string): Promise<string | null> {
  const url = `${cfg.apiBase}/api/workflow-instances/pending-executions/${encodeURIComponent(id)}/claim`;
  const { status, body } = await httpJson(url, { method: "POST", headers: headers(cfg) }, cfg.httpTimeoutMs);
  if (status === 409) return null; // another runner won the claim
  if (status !== 200) throw new Error(`claim failed (HTTP ${status})`);
  const token = (body as { claimToken?: string } | undefined)?.claimToken;
  return typeof token === "string" && token ? token : null;
}

async function complete(cfg: RunnerConfig, id: string, payload: Record<string, unknown>): Promise<void> {
  const url = `${cfg.apiBase}/api/workflow-instances/pending-executions/${encodeURIComponent(id)}/complete`;
  const { status } = await httpJson(url, { method: "POST", headers: headers(cfg), body: JSON.stringify(payload) }, cfg.httpTimeoutMs);
  // 409 = already completed / lost the token — nothing to do, don't crash the loop.
  if (status !== 200 && status !== 409) throw new Error(`complete failed (HTTP ${status})`);
}

async function processOne(cfg: RunnerConfig, row: PendingRow): Promise<void> {
  const claimToken = await claim(cfg, row.id);
  if (!claimToken) return; // lost the claim (409) — skip
  try {
    const { result } = await runNode({
      nodeType: row.node?.nodeType ?? "",
      config: row.node?.config ?? {},
      context: row.payload,
      instanceId: row.instanceId,
      nodeId: row.nodeId,
    });
    await complete(cfg, row.id, { claimToken, result });
    log("completed", { id: row.id, nodeType: row.node?.nodeType });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await complete(cfg, row.id, { claimToken, error: message });
    log("failed", { id: row.id, nodeType: row.node?.nodeType, error: message });
  }
}

async function processBatch(cfg: RunnerConfig, rows: PendingRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += cfg.maxConcurrency) {
    const batch = rows.slice(i, i + cfg.maxConcurrency);
    await Promise.all(batch.map((row) => processOne(cfg, row).catch((e) => log("process error", { id: row.id, error: (e as Error).message }))));
  }
}

export async function runPollLoop(cfg: RunnerConfig = loadRunnerConfig(), opts: { signal?: AbortSignal } = {}): Promise<void> {
  log("starting", { location: cfg.location, api: cfg.apiBase, interval: cfg.pollIntervalMs, concurrency: cfg.maxConcurrency });
  while (!opts.signal?.aborted) {
    try {
      const rows = await poll(cfg);
      if (rows.length) await processBatch(cfg, rows);
    } catch (err) {
      log("poll cycle error", { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs));
  }
  log("stopped");
}

if (require.main === module) {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  runPollLoop(loadRunnerConfig(), { signal: controller.signal }).catch((err) => {
    console.error(`[poll-runner] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
