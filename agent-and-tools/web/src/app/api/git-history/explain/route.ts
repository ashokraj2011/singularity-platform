import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { readJsonish, readRequestJson } from "../../_json";
import {
  flagEnabled,
  iamApiBase as platformIamApiBase,
  platformEnvName,
  platformServiceToken,
  platformServiceUrl,
} from "@/lib/platformServices";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const GIT_HISTORY_IAM_VERIFY_TIMEOUT_MS = boundedSecondsEnv("GIT_HISTORY_IAM_VERIFY_TIMEOUT_SEC", 5, 1, 300) * 1000;
const GIT_HISTORY_RUNTIME_STATUS_TIMEOUT_MS = boundedSecondsEnv("GIT_HISTORY_RUNTIME_STATUS_TIMEOUT_SEC", 5, 1, 300) * 1000;
const TOOL_NAME = "git_history_explain";

type ExplainRequest = {
  since?: string;
  until?: string;
  paths?: string[];
  author?: string;
  noMerges?: boolean;
  maxCommits?: number;
  format?: "markdown" | "json";
  runtimeUserId?: string;
  tenantId?: string;
  sourceUri?: string;
  sourceRef?: string;
  sourceType?: string;
  workspaceId?: string;
  repoPath?: string;
};

type RuntimeIdentity = {
  userId: string | null;
  tenantId: string | null;
  source: string;
};

type GitHistoryOutput = {
  generatedAt?: string;
  executionPath?: string;
  repo?: string;
  script?: string;
  format?: "markdown" | "json";
  report?: string;
  parsed?: unknown;
  stderr?: string | null;
};

function cleanText(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\0\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function cleanPath(value: unknown): string | null {
  const text = cleanText(value, 220);
  if (!text || path.isAbsolute(text) || text.split(/[\\/]+/).includes("..")) return null;
  return text;
}

function clampMaxCommits(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 250;
  return Math.max(1, Math.min(parsed, 500));
}

function platformProductionClass(): boolean {
  const env = platformEnvName();
  return ["production", "staging", "perf"].includes(env) || process.env.AUTH_OPTIONAL === "false";
}

function contextFabricUrl(): string {
  return platformServiceUrl("context-fabric");
}

function contextFabricServiceToken(): string | null {
  return platformServiceToken("context-fabric");
}

function iamApiBase(): string {
  return platformIamApiBase();
}

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readIdentity(value: unknown): RuntimeIdentity | null {
  if (!isRecord(value)) return null;
  const userId = cleanText(value.user_id ?? value.userId ?? value.id ?? value.sub, 160);
  const tenantIds = Array.isArray(value.tenant_ids) ? value.tenant_ids : [];
  const tenantId = cleanText(value.tenant_id ?? value.tenantId ?? tenantIds[0], 160);
  if (!userId && !tenantId) return null;
  return { userId, tenantId, source: "caller-token" };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function verifiedCallerIdentity(req: NextRequest): Promise<RuntimeIdentity | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const serviceToken = process.env.IAM_SERVICE_TOKEN?.trim();
  if (serviceToken) {
    try {
      const verify = await fetch(`${iamApiBase()}/auth/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: serviceToken.startsWith("Bearer ") ? serviceToken : `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({ token }),
        cache: "no-store",
        signal: AbortSignal.timeout(GIT_HISTORY_IAM_VERIFY_TIMEOUT_MS),
      });
      if (verify.ok) {
        const body = (await readJsonish(verify)).data as { valid?: boolean; user?: unknown } | null;
        if (body?.valid) return readIdentity(body.user);
      }
    } catch {
      // Fall back to JWT payload in local/dev below.
    }
  }
  if (!platformProductionClass()) {
    return readIdentity(decodeJwtPayload(token));
  }
  return null;
}

function envRuntimeIdentity(): RuntimeIdentity | null {
  const userId = cleanText(process.env.GIT_HISTORY_RUNTIME_USER_ID || process.env.SINGULARITY_USER_ID, 160);
  const tenantId = cleanText(
    process.env.GIT_HISTORY_RUNTIME_TENANT_ID ||
      process.env.SINGULARITY_TENANT_ID ||
      (process.env.IAM_SERVICE_TOKEN_TENANT_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean)[0],
    160,
  );
  if (!userId && !tenantId) return null;
  return { userId, tenantId, source: "platform-env" };
}

async function singleConnectedRuntimeIdentity(): Promise<RuntimeIdentity | null> {
  if (platformProductionClass()) return null;
  try {
    const token = contextFabricServiceToken();
    const res = await fetch(`${contextFabricUrl()}/api/runtime-bridge/status`, {
      cache: "no-store",
      headers: token ? { "X-Service-Token": token } : {},
      signal: AbortSignal.timeout(GIT_HISTORY_RUNTIME_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await readJsonish(res)).data;
    const connected = isRecord(body) && Array.isArray(body.connected) ? body.connected : [];
    if (connected.length !== 1) return null;
    const identity = readIdentity(connected[0]);
    return identity ? { ...identity, source: "single-connected-runtime" } : null;
  } catch {
    return null;
  }
}

function devRuntimeOverride(body: ExplainRequest): RuntimeIdentity | null {
  if (platformProductionClass() || !flagEnabled(process.env.GIT_HISTORY_ALLOW_RUNTIME_OVERRIDE)) return null;
  const userId = cleanText(body.runtimeUserId, 160);
  const tenantId = cleanText(body.tenantId, 160);
  if (!userId && !tenantId) return null;
  return { userId, tenantId, source: "request-dev-override" };
}

async function runtimeIdentity(req: NextRequest, body: ExplainRequest): Promise<RuntimeIdentity | null> {
  return (
    await verifiedCallerIdentity(req) ??
    envRuntimeIdentity() ??
    devRuntimeOverride(body) ??
    await singleConnectedRuntimeIdentity()
  );
}

function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ".git")) && existsSync(path.join(current, "bin", "explain-git-history.py"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveRepo(): { repo: string; script: string } | { error: NextResponse } {
  const configuredRepo = cleanText(process.env.GIT_HISTORY_REPO, 600);
  const repo = configuredRepo ? path.resolve(configuredRepo) : findRepoRoot(process.cwd());
  if (!repo || !existsSync(path.join(repo, ".git"))) {
    return {
      error: NextResponse.json(
        {
          code: "GIT_HISTORY_REPO_UNAVAILABLE",
          message: "Local debug fallback cannot see a git checkout. Set GIT_HISTORY_REPO or use the Runtime Bridge path.",
          fixCommand: "GIT_HISTORY_REPO=/path/to/singularity-platform GIT_HISTORY_LOCAL_FALLBACK_ENABLED=true bin/bare-metal-apps.sh up",
        },
        { status: 503 },
      ),
    };
  }

  const configuredScript = cleanText(process.env.GIT_HISTORY_SCRIPT, 800);
  const script = configuredScript ? path.resolve(configuredScript) : path.join(repo, "bin", "explain-git-history.py");
  if (!existsSync(script) || !statSync(script).isFile()) {
    return {
      error: NextResponse.json(
        {
          code: "GIT_HISTORY_SCRIPT_UNAVAILABLE",
          message: "The local debug git history explainer script was not found.",
          expected: script,
        },
        { status: 503 },
      ),
    };
  }

  return { repo, script };
}

function sourceTypeFor(sourceUri: string | null, requested: string | null): string | null {
  if (requested) return requested;
  if (!sourceUri) return null;
  if (/github\.com[:/]/i.test(sourceUri)) return "github";
  if (sourceUri.startsWith("/") || sourceUri.startsWith("file://") || sourceUri.startsWith("~")) return "local";
  return null;
}

function sourceConfig(body: ExplainRequest): { sourceUri: string | null; sourceRef: string | null; sourceType: string | null } {
  const allowRequestSource = flagEnabled(process.env.GIT_HISTORY_ALLOW_SOURCE_OVERRIDE) && !platformProductionClass();
  const sourceUri = cleanText(process.env.GIT_HISTORY_SOURCE_URI, 1000) || (allowRequestSource ? cleanText(body.sourceUri, 1000) : null);
  const sourceRef = cleanText(process.env.GIT_HISTORY_SOURCE_REF, 160) || (allowRequestSource ? cleanText(body.sourceRef, 160) : null);
  const requestedType = cleanText(process.env.GIT_HISTORY_SOURCE_TYPE, 80) || (allowRequestSource ? cleanText(body.sourceType, 80) : null);
  return { sourceUri, sourceRef, sourceType: sourceTypeFor(sourceUri, requestedType) };
}

function normalizedToolArgs(body: ExplainRequest): Record<string, unknown> {
  return {
    since: cleanText(body.since, 80),
    until: cleanText(body.until, 80),
    paths: Array.isArray(body.paths) ? body.paths.map(cleanPath).filter((item): item is string => Boolean(item)) : [],
    author: cleanText(body.author, 120) ?? undefined,
    no_merges: Boolean(body.noMerges),
    max_commits: clampMaxCommits(body.maxCommits),
    format: body.format === "json" ? "json" : "markdown",
    repo_path: cleanPath(body.repoPath) ?? cleanPath(process.env.GIT_HISTORY_REPO_PATH),
  };
}

function responseFromToolOutput(
  output: GitHistoryOutput,
  details: { servedBy?: string; durationMs?: number; toolInvocationId?: string; identity?: RuntimeIdentity },
): NextResponse {
  const format = output.format === "json" ? "json" : "markdown";
  return NextResponse.json({
    generatedAt: output.generatedAt ?? new Date().toISOString(),
    repo: output.repo ?? "runtime workspace",
    script: output.script ?? TOOL_NAME,
    format,
    report: output.report ?? "",
    parsed: output.parsed ?? null,
    stderr: output.stderr ?? null,
    executionPath: output.executionPath ?? "context-fabric-runtime-bridge",
    servedBy: details.servedBy ?? null,
    durationMs: details.durationMs ?? null,
    toolInvocationId: details.toolInvocationId ?? null,
    runtimeIdentity: details.identity ?? null,
  });
}

function runtimeUnavailable(detail: string, identity: RuntimeIdentity | null): NextResponse {
  return NextResponse.json(
    {
      code: "GIT_HISTORY_RUNTIME_UNAVAILABLE",
      message: "Git Change Explainer now uses the platform Runtime Bridge path. Connect an MCP runtime or explicitly enable local debug fallback.",
      detail,
      runtimeIdentity: identity,
      fixRoute: "/llm-settings",
      fixCommand: "bin/mcp-runtime-setup.sh --start",
      debugFallback: "Set GIT_HISTORY_LOCAL_FALLBACK_ENABLED=true only for local debugging.",
    },
    { status: 503 },
  );
}

async function runViaRuntimeBridge(req: NextRequest, body: ExplainRequest): Promise<NextResponse | null> {
  if (process.env.GIT_HISTORY_CONTEXT_FABRIC_ENABLED === "false") return null;

  const identity = await runtimeIdentity(req, body);
  if (!identity?.userId && !identity?.tenantId) {
    return runtimeUnavailable("No caller/runtime user_id or tenant_id was available for Context Fabric runtime routing.", identity);
  }

  const serviceToken = contextFabricServiceToken();
  const source = sourceConfig(body);
  const runContext: Record<string, unknown> = {
    user_id: identity.userId ?? undefined,
    tenant_id: identity.tenantId ?? undefined,
    prefer_laptop: true,
    capability_tags: ["mcp", "tools", "git"],
    capability_id: "operations.git-history",
    repo_access: true,
    source_type: source.sourceType ?? undefined,
    source_uri: source.sourceUri ?? undefined,
    source_ref: source.sourceRef ?? undefined,
    workspaceRoot: cleanText(process.env.GIT_HISTORY_WORKSPACE_ROOT, 800) ?? undefined,
  };

  const payload = {
    tool_name: TOOL_NAME,
    args: normalizedToolArgs(body),
    workspace_id: cleanText(body.workspaceId, 120) ?? process.env.GIT_HISTORY_WORKSPACE_ID ?? "git-history-explain",
    run_context: runContext,
    laptop_user_id: identity.userId ?? undefined,
  };

  try {
    const res = await fetch(`${contextFabricUrl()}/api/runtime-bridge/tool-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(serviceToken ? { "X-Service-Token": serviceToken } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS + 15_000),
    });
    const body = await readJsonish(res, 1200);
    const parsed = isRecord(body.data) ? body.data as Record<string, unknown> : {};
    if (!res.ok) {
      return runtimeUnavailable(
        isRecord(body.data) ? String(parsed.detail ?? parsed.message ?? body.text).slice(0, 800) : body.text.slice(0, 800),
        identity,
      );
    }
    const toolSuccess = parsed.tool_success === true;
    if (!toolSuccess) {
      return NextResponse.json(
        {
          code: "GIT_HISTORY_TOOL_FAILED",
          message: String(parsed.tool_error ?? "The runtime executed the git history tool but reported failure."),
          servedBy: parsed.served_by ?? null,
          toolInvocationId: parsed.tool_invocation_id ?? null,
        },
        { status: 502 },
      );
    }
    const output = isRecord(parsed.result) ? parsed.result as GitHistoryOutput : {};
    if (typeof output.report !== "string") {
      return NextResponse.json(
        {
          code: "GIT_HISTORY_BAD_TOOL_OUTPUT",
          message: "The runtime returned a successful response, but it did not include a git history report.",
          raw: parsed,
        },
        { status: 502 },
      );
    }
    return responseFromToolOutput(output, {
      servedBy: typeof parsed.served_by === "string" ? parsed.served_by : undefined,
      durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined,
      toolInvocationId: typeof parsed.tool_invocation_id === "string" ? parsed.tool_invocation_id : undefined,
      identity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Context Fabric runtime dispatch failed";
    return runtimeUnavailable(message, identity);
  }
}

async function runLocalFallback(body: ExplainRequest): Promise<NextResponse> {
  const resolved = resolveRepo();
  if ("error" in resolved) return resolved.error;

  const format = body.format === "json" ? "json" : "markdown";
  const args = [
    resolved.script,
    "--since",
    cleanText(body.since, 80) ?? "",
    "--until",
    cleanText(body.until, 80) ?? "",
    "--max-commits",
    String(clampMaxCommits(body.maxCommits)),
    "--format",
    format,
  ];

  const paths = Array.isArray(body.paths) ? body.paths.map(cleanPath).filter((item): item is string => Boolean(item)) : [];
  for (const item of paths) args.push("--path", item);
  const author = cleanText(body.author, 120);
  if (author) args.push("--author", author);
  if (body.noMerges) args.push("--no-merges");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.env.GIT_HISTORY_PYTHON?.trim() || "python3",
      args,
      {
        cwd: resolved.repo,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );
    let parsed: unknown = null;
    if (format === "json") {
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
    }
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      repo: resolved.repo,
      script: path.relative(resolved.repo, resolved.script),
      format,
      report: stdout,
      parsed,
      stderr: stderr?.trim() || null,
      executionPath: "platform-web-local-debug-fallback",
      servedBy: "platform-web",
      durationMs: null,
      toolInvocationId: null,
      runtimeIdentity: null,
    });
  } catch (err) {
    const error = err as { message?: string; stderr?: string; stdout?: string; code?: string | number; signal?: string };
    return NextResponse.json(
      {
        code: "GIT_HISTORY_EXPLAIN_FAILED",
        message: error.stderr?.trim() || error.message || "Git history explanation failed.",
        stdout: error.stdout?.slice(0, 4000) || null,
        exitCode: error.code ?? null,
        signal: error.signal ?? null,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const requestBody = await readRequestJson(req);
  if (requestBody.parseError) {
    return NextResponse.json(
      { code: "INVALID_JSON", message: "Request body must be valid JSON.", detail: requestBody.text },
      { status: 400 },
    );
  }
  const body = requestBody.data && typeof requestBody.data === "object" && !Array.isArray(requestBody.data)
    ? requestBody.data as ExplainRequest
    : {};

  const since = cleanText(body.since, 80);
  const until = cleanText(body.until, 80);
  if (!since || !until) {
    return NextResponse.json(
      { code: "GIT_HISTORY_RANGE_REQUIRED", message: "Both since and until dates are required." },
      { status: 400 },
    );
  }

  const bridgeResponse = await runViaRuntimeBridge(req, body);
  if (bridgeResponse?.ok || !flagEnabled(process.env.GIT_HISTORY_LOCAL_FALLBACK_ENABLED)) {
    return bridgeResponse ?? runtimeUnavailable("Context Fabric runtime dispatch is disabled.", null);
  }

  return runLocalFallback(body);
}
