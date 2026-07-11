import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../_proxy";
import { readJsonish } from "../_json";
import { localDevAllowsAnonymousRead } from "@/lib/platformServices";
import { serverEnv } from "@/lib/serverRootEnv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "unknown";

type LogRow = {
  id: string;
  source: string;
  service: string;
  level: LogLevel;
  message: string;
  timestamp: string | null;
  rawTime: string | null;
  lineNumber: number;
  traceId: string | null;
  otelTraceId: string | null;
  workflowInstanceId: string | null;
  agentRunId: string | null;
  backend: "local" | "central";
};

type LogCorrelation = Pick<LogRow, "traceId" | "otelTraceId" | "workflowInstanceId" | "agentRunId">;

const LOG_EXTENSIONS = new Set([".log", ".out", ".err"]);
const DEFAULT_LIMIT = 350;
const MAX_LIMIT = 1500;
const DEFAULT_BYTES_PER_FILE = 180_000;
const MAX_BYTES_PER_FILE = 900_000;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function serviceName(filename: string): string {
  return filename
    .replace(/\.(log|out|err)$/i, "")
    .replace(/^launch-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function firstExistingLogDir(): Promise<string | null> {
  const candidates = unique([
    serverEnv("SINGULARITY_LOG_DIR") ?? "",
    path.resolve(process.cwd(), "../../logs"),
    path.resolve(process.cwd(), "../logs"),
    path.resolve(process.cwd(), "logs"),
    "/app/logs",
  ].filter(Boolean));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(ghp|github_pat|glpat|sk-ant|sk-proj|sk)[A-Za-z0-9_:-]{12,}/g, "[REDACTED_TOKEN]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|bearer)\b(\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, "$1$2$3[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\b(\s*[:=]\s*)(['"]?)[^\s'",}]+/g, (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]`);
}

function levelFromPino(value: unknown): LogLevel {
  if (typeof value === "number") {
    if (value >= 60) return "fatal";
    if (value >= 50) return "error";
    if (value >= 40) return "warn";
    if (value >= 30) return "info";
    if (value >= 20) return "debug";
    if (value >= 10) return "trace";
  }
  if (typeof value === "string") return normalizeLevel(value);
  return "unknown";
}

function normalizeLevel(value: string): LogLevel {
  const text = value.toLowerCase();
  if (/\bfatal\b|\bcritical\b/.test(text)) return "fatal";
  if (/\berror\b|\bexception\b|\bunhandled\b|\btraceback\b|\beaddrinuse\b|\bfailed\b/.test(text)) return "error";
  if (/\bwarn(ing)?\b|\bdegraded\b|\bretry\b/.test(text)) return "warn";
  if (/\bdebug\b/.test(text)) return "debug";
  if (/\btrace\b/.test(text)) return "trace";
  if (/\binfo\b|\bok\b|\bstarted\b|\blistening\b|\bhealthy\b|\bcomplete\b/.test(text)) return "info";
  return "unknown";
}

function extractTimestamp(line: string): { timestamp: string | null; rawTime: string | null } {
  const iso = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/);
  if (iso) {
    const parsed = new Date(iso[0].endsWith("Z") ? iso[0] : `${iso[0]}Z`);
    return { timestamp: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(), rawTime: iso[0] };
  }
  const bracketTime = line.match(/\[(\d{2}:\d{2}:\d{2})\]/);
  if (bracketTime) return { timestamp: null, rawTime: bracketTime[1] };
  const time = line.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  if (time) return { timestamp: null, rawTime: time[1] };
  return { timestamp: null, rawTime: null };
}

function hashText(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function nestedRecords(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    parsed,
    parsed.context,
    parsed.correlation,
    parsed.runContext,
    parsed.run_context,
    parsed.payload,
    parsed.headers,
  ];
  return candidates.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
}

function correlationFromJson(parsed: Record<string, unknown>): LogCorrelation {
  const records = nestedRecords(parsed);
  const pick = (...keys: string[]) => {
    for (const item of records) {
      const value = firstString(...keys.map((key) => item[key]));
      if (value) return value;
    }
    return null;
  };
  const traceparent = pick("traceparent", "traceParent");
  return {
    traceId: pick("traceId", "trace_id", "x-singularity-trace-id"),
    otelTraceId: pick("otelTraceId", "otel_trace_id")
      ?? traceparent?.match(/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i)?.[1]
      ?? null,
    workflowInstanceId: pick("workflowInstanceId", "workflow_instance_id", "runId", "run_id"),
    agentRunId: pick("agentRunId", "agent_run_id"),
  };
}

function capture(line: string, names: string[]): string | null {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = line.match(new RegExp(`(?:${escaped})["']?\\s*(?:=|:|\\s)\\s*["']?([A-Za-z0-9._:/-]{3,300})`, "i"));
  return match?.[1]?.replace(/["',;}\]]+$/, "") ?? null;
}

function correlationFromText(line: string): LogCorrelation {
  const traceparent = capture(line, ["traceparent", "traceParent"]);
  return {
    traceId: capture(line, ["x-singularity-trace-id", "trace_id", "traceId"]),
    otelTraceId: capture(line, ["otel_trace_id", "otelTraceId"])
      ?? traceparent?.match(/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i)?.[1]
      ?? null,
    workflowInstanceId: capture(line, ["workflow_instance_id", "workflowInstanceId", "run_id", "runId"]),
    agentRunId: capture(line, ["agent_run_id", "agentRunId"]),
  };
}

function parseJsonLine(line: string): { level?: LogLevel; message?: string; timestamp?: string | null; correlation?: LogCorrelation } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const msg = parsed.msg ?? parsed.message ?? parsed.err ?? parsed.error;
    const time = parsed.time ?? parsed.timestamp ?? parsed.ts;
    const date = typeof time === "number"
      ? new Date(time < 10_000_000_000 ? time * 1000 : time)
      : typeof time === "string"
        ? new Date(time)
        : null;
    const timestamp = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
    return {
      level: levelFromPino(parsed.level),
      message: typeof msg === "string" ? msg : undefined,
      timestamp: timestamp && timestamp !== "Invalid Date" ? timestamp : null,
      correlation: correlationFromJson(parsed),
    };
  } catch {
    return null;
  }
}

async function readTail(filePath: string, maxBytes: number): Promise<{ text: string; size: number }> {
  const stat = await fs.stat(filePath);
  const size = stat.size;
  const bytes = Math.min(maxBytes, size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, Math.max(0, size - bytes));
    return { text: buffer.toString("utf8"), size };
  } finally {
    await handle.close();
  }
}

function parseRows(source: string, text: string): LogRow[] {
  const service = serviceName(source);
  return text
    .split(/\r?\n/)
    .map(stripAnsi)
    .map(redact)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, index }) => {
      const json = parseJsonLine(line);
      const extracted = extractTimestamp(line);
      const message = json?.message ?? line.trim();
      const level = json?.level && json.level !== "unknown" ? json.level : normalizeLevel(line);
      const timestamp = json?.timestamp ?? extracted.timestamp;
      const textCorrelation = correlationFromText(line);
      const correlation = json?.correlation ?? textCorrelation;
      return {
        id: `${source}:${index}:${hashText(line)}`,
        source,
        service,
        level,
        message,
        timestamp,
        rawTime: extracted.rawTime,
        lineNumber: index + 1,
        traceId: correlation.traceId ?? textCorrelation.traceId,
        otelTraceId: correlation.otelTraceId ?? textCorrelation.otelTraceId,
        workflowInstanceId: correlation.workflowInstanceId ?? textCorrelation.workflowInstanceId,
        agentRunId: correlation.agentRunId ?? textCorrelation.agentRunId,
        backend: "local",
      };
    });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function centralLogRows(value: unknown): LogRow[] {
  const items = Array.isArray(record(value).items) ? record(value).items as unknown[] : [];
  return items.map((item, index) => {
    const row = record(item);
    const source = firstString(row.service, "central-log") ?? "central-log";
    const timestamp = firstString(row.ts, row.created_at);
    return {
      id: `central:${firstString(row.id, String(index)) ?? index}`,
      source,
      service: source,
      level: normalizeLevel(firstString(row.level, "unknown") ?? "unknown"),
      message: redact(firstString(row.message, row.event_type, "log event") ?? "log event"),
      timestamp,
      rawTime: timestamp,
      lineNumber: 0,
      traceId: firstString(row.trace_id, row.traceId),
      otelTraceId: firstString(row.otel_trace_id, row.otelTraceId),
      workflowInstanceId: firstString(row.workflow_instance_id, row.workflowInstanceId),
      agentRunId: firstString(row.agent_run_id, row.agentRunId, row.run_id, row.runId),
      backend: "central",
    };
  });
}

async function searchCentralLogs(request: NextRequest, input: {
  q: string;
  level: string;
  source: string;
  traceId: string;
  limit: number;
}): Promise<{ rows: LogRow[]; ok: boolean; warning?: string }> {
  const headers = new Headers({ "content-type": "application/json" });
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  try {
    const res = await fetch(`${request.nextUrl.origin}/api/audit-gov/logs/search`, {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({
        ...(input.q ? { q: input.q } : {}),
        ...(input.level !== "all" ? { levels: [input.level] } : {}),
        ...(input.source !== "all" ? { services: [input.source] } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        limit: input.limit,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await readJsonish(res, 800);
    if (!res.ok) return { rows: [], ok: false, warning: `Central log lake unavailable (HTTP ${res.status}): ${body.text.slice(0, 240)}` };
    return { rows: centralLogRows(body.data), ok: true };
  } catch (error) {
    return { rows: [], ok: false, warning: `Central log lake unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function matches(row: LogRow, q: string, level: string, source: string, traceId: string): boolean {
  if (source !== "all" && row.source !== source) return false;
  if (level !== "all" && row.level !== level) return false;
  if (traceId && row.traceId !== traceId) return false;
  if (!q) return true;
  const haystack = `${row.source} ${row.service} ${row.level} ${row.message} ${row.traceId ?? ""} ${row.workflowInstanceId ?? ""} ${row.agentRunId ?? ""}`.toLowerCase();
  return haystack.includes(q);
}

export async function GET(request: NextRequest) {
  if (!localDevAllowsAnonymousRead("PLATFORM_LOGS_AUTH_REQUIRED")) {
    const authFailure = await requireVerifiedCallerBearer(request, "Platform logs");
    if (authFailure) return authFailure;
  }

  const logDir = await firstExistingLogDir();
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const traceId = (url.searchParams.get("trace_id") ?? url.searchParams.get("traceId") ?? "").trim();
  const level = (url.searchParams.get("level") ?? "all").toLowerCase();
  const source = url.searchParams.get("source") ?? "all";
  const backend = (url.searchParams.get("backend") ?? "all").toLowerCase();
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxBytes = clampInt(url.searchParams.get("bytes"), DEFAULT_BYTES_PER_FILE, 10_000, MAX_BYTES_PER_FILE);

  const files = logDir ? await fs.readdir(logDir, { withFileTypes: true }).then((entries) => Promise.all(entries
      .filter((entry) => entry.isFile() && LOG_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const filePath = path.resolve(logDir, entry.name);
        if (!isSubPath(logDir, filePath)) return null;
        const stat = await fs.stat(filePath);
        return { source: entry.name, service: serviceName(entry.name), size: stat.size, updatedAt: stat.mtime.toISOString() };
      }))) : [];
  const visibleFiles = files.filter((file): file is NonNullable<typeof file> => Boolean(file));
  const selectedFiles = visibleFiles.filter((file) => source === "all" || file.source === source);

  const chunks = logDir ? await Promise.all(selectedFiles.map(async (file) => {
    const filePath = path.resolve(logDir, file.source);
    const tail = await readTail(filePath, maxBytes);
    return { ...file, ...tail };
  })) : [];

  const localRows = chunks
    .flatMap((chunk) => parseRows(chunk.source, chunk.text))
    .filter((row) => matches(row, q, level, source, traceId))
    .slice(-limit)
    .reverse();

  const central = backend === "local"
    ? { rows: [] as LogRow[], ok: false, warning: undefined }
    : await searchCentralLogs(request, { q, level, source, traceId, limit });
  const rows = [
    ...(backend === "central" ? [] : localRows),
    ...central.rows.filter((row) => matches(row, q, level, source, traceId)),
  ]
    .sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""))
    .slice(0, limit);

  const centralFiles = [...new Map(central.rows.map((row) => [row.source, {
    source: row.source,
    service: row.service,
    size: 0,
    updatedAt: row.timestamp ?? new Date(0).toISOString(),
    backend: "central" as const,
  }])).values()];
  const allFiles = [
    ...(backend === "central" ? [] : visibleFiles.map((file) => ({ ...file, backend: "local" as const }))),
    ...centralFiles,
  ];

  const byLevel = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.level] = (acc[row.level] ?? 0) + 1;
    return acc;
  }, {});
  const bySource = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});
  const errorSources = Object.entries(rows.reduce<Record<string, number>>((acc, row) => {
    if (row.level === "error" || row.level === "fatal") acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {}))
    .map(([sourceName, count]) => ({ source: sourceName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const traced = rows.filter((row) => row.traceId).length;
  const traceIds = [...new Set(rows.flatMap((row) => row.traceId ? [row.traceId] : []))].slice(0, 50);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    logDir,
    files: allFiles,
    query: { q, traceId, level, source, backend, limit, bytes: maxBytes },
    items: rows,
    summary: { total: rows.length, traced, traceIds, byLevel, bySource, errorSources },
    backends: {
      local: { ok: Boolean(logDir), sourceCount: visibleFiles.length },
      central: { ok: central.ok, sourceCount: centralFiles.length, warning: central.warning ?? null },
    },
    warnings: central.warning ? [central.warning] : [],
    message: !logDir && central.rows.length === 0
      ? "No local log directory was found and the central log lake returned no rows. Set SINGULARITY_LOG_DIR or enable audit-governance log ingestion."
      : undefined,
  });
}
