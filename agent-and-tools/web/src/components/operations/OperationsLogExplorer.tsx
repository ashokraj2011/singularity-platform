"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  Bug,
  Clock,
  Download,
  FileText,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Waypoints,
} from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "unknown";

type LogFile = {
  source: string;
  service: string;
  size: number;
  updatedAt: string;
  backend?: "local" | "central";
};

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

type LogsResponse = {
  generatedAt?: string;
  logDir?: string | null;
  files: LogFile[];
  items: LogRow[];
  summary: {
    total?: number;
    traced?: number;
    traceIds?: string[];
    byLevel?: Record<string, number>;
    bySource?: Record<string, number>;
    errorSources?: Array<{ source: string; count: number }>;
  };
  message?: string;
  warnings?: string[];
  backends?: {
    local?: { ok?: boolean; sourceCount?: number };
    central?: { ok?: boolean; sourceCount?: number; warning?: string | null };
  };
};

const levels = ["all", "fatal", "error", "warn", "info", "debug", "trace", "unknown"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeLogs(value: unknown): LogsResponse {
  const row = isRecord(value) ? value : {};
  const files = Array.isArray(row.files)
    ? row.files.filter(isRecord).map((file) => ({
      source: asString(file.source),
      service: asString(file.service, asString(file.source)),
      size: asNumber(file.size),
      updatedAt: asString(file.updatedAt),
      backend: file.backend === "central" ? "central" as const : "local" as const,
    })).filter((file) => file.source)
    : [];
  const items = Array.isArray(row.items)
    ? row.items.filter(isRecord).map((item) => ({
      id: asString(item.id, `${asString(item.source)}:${asNumber(item.lineNumber)}`),
      source: asString(item.source),
      service: asString(item.service, asString(item.source)),
      level: normalizeLevel(item.level),
      message: asString(item.message),
      timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
      rawTime: typeof item.rawTime === "string" ? item.rawTime : null,
      lineNumber: asNumber(item.lineNumber),
      traceId: typeof item.traceId === "string" ? item.traceId : null,
      otelTraceId: typeof item.otelTraceId === "string" ? item.otelTraceId : null,
      workflowInstanceId: typeof item.workflowInstanceId === "string" ? item.workflowInstanceId : null,
      agentRunId: typeof item.agentRunId === "string" ? item.agentRunId : null,
      backend: item.backend === "central" ? "central" as const : "local" as const,
    })).filter((item) => item.source && item.message)
    : [];
  const summary = isRecord(row.summary) ? row.summary : {};
  return {
    generatedAt: asString(row.generatedAt),
    logDir: typeof row.logDir === "string" ? row.logDir : null,
    files,
    items,
    message: asString(row.message),
    warnings: Array.isArray(row.warnings) ? row.warnings.filter((item): item is string => typeof item === "string") : [],
    backends: isRecord(row.backends) ? row.backends as LogsResponse["backends"] : undefined,
    summary: {
      total: asNumber(summary.total, items.length),
      traced: asNumber(summary.traced),
      traceIds: Array.isArray(summary.traceIds) ? summary.traceIds.filter((item): item is string => typeof item === "string") : [],
      byLevel: isRecord(summary.byLevel) ? numberRecord(summary.byLevel) : {},
      bySource: isRecord(summary.bySource) ? numberRecord(summary.bySource) : {},
      errorSources: Array.isArray(summary.errorSources)
        ? summary.errorSources.filter(isRecord).map((item) => ({ source: asString(item.source), count: asNumber(item.count) })).filter((item) => item.source)
        : [],
    },
  };
}

function normalizeLevel(value: unknown): LogLevel {
  const text = asString(value, "unknown").toLowerCase();
  return ["fatal", "error", "warn", "info", "debug", "trace", "unknown"].includes(text) ? text as LogLevel : "unknown";
}

function numberRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, asNumber(count)]));
}

async function fetchLogs(url: string): Promise<LogsResponse> {
  const res = await fetch(apiPath(url), { headers: authHeaders(), cache: "no-store" });
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  assertValidApiResponse(url, raw, parseError);
  return normalizeLogs(parsed);
}

function bytesLabel(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function dateLabel(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function encodeParams(params: Record<string, string | number>): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (String(value).trim()) query.set(key, String(value));
  });
  return query.toString();
}

function downloadRows(rows: LogRow[]) {
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  const blob = new Blob([text], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `singularity-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  link.click();
  URL.revokeObjectURL(url);
}

function levelTone(level: LogLevel): string {
  if (level === "fatal") return "#fb7185";
  if (level === "error") return "#ef4444";
  if (level === "warn") return "#f59e0b";
  if (level === "info") return "#38bdf8";
  if (level === "debug") return "#a78bfa";
  if (level === "trace") return "#94a3b8";
  return "#64748b";
}

export function OperationsLogExplorer() {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const [traceId, setTraceId] = useState(() => searchParams.get("trace_id") ?? "");
  const [source, setSource] = useState("all");
  const [level, setLevel] = useState<(typeof levels)[number]>("all");
  const [limit, setLimit] = useState(350);
  const [backend, setBackend] = useState<"all" | "central" | "local">("all");
  const [paused, setPaused] = useState(false);

  const params = useMemo(() => encodeParams({ q: query, trace_id: traceId, source, level, backend, limit }), [backend, level, limit, query, source, traceId]);
  const { data, error, isLoading, mutate } = useSWR(`/api/platform-logs?${params}`, fetchLogs, {
    refreshInterval: paused ? 0 : 5000,
    keepPreviousData: true,
  });

  const rows = data?.items ?? [];
  const files = data?.files ?? [];
  const errors = (data?.summary.byLevel?.fatal ?? 0) + (data?.summary.byLevel?.error ?? 0);
  const warnings = data?.summary.byLevel?.warn ?? 0;
  const activeSources = Object.keys(data?.summary.bySource ?? {}).length;
  const traced = data?.summary.traced ?? 0;

  return (
    <main className="space-y-5">
      <section className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label-xs mb-2 text-[var(--color-outline)]">Operations Center</div>
            <h1 className="text-2xl font-black text-[var(--color-text)]">Log Explorer</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--color-outline)]">
              Search local platform logs across WorkGraph, Context Fabric, IAM, LLM Gateway, MCP, Prompt Composer, Agent Runtime, and Platform Web. Secrets are redacted at the server boundary.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" type="button" onClick={() => setPaused((value) => !value)}>
              {paused ? <Play size={15} /> : <Pause size={15} />} {paused ? "Resume live tail" : "Pause"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => void mutate()}>
              <RefreshCw size={15} /> Refresh
            </button>
            <button className="btn-secondary" type="button" onClick={() => downloadRows(rows)} disabled={rows.length === 0}>
              <Download size={15} /> Export NDJSON
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <Metric icon={<TerminalSquare size={17} />} label="Visible events" value={String(data?.summary.total ?? rows.length)} detail={`${files.length} log files`} tone="#2563eb" />
        <Metric icon={<Bug size={17} />} label="Errors" value={String(errors)} detail="fatal + error" tone={errors > 0 ? "#dc2626" : "#15803d"} />
        <Metric icon={<AlertTriangle size={17} />} label="Warnings" value={String(warnings)} detail="needs attention" tone={warnings > 0 ? "#d97706" : "#15803d"} />
        <Metric icon={<Waypoints size={17} />} label="Trace-linked" value={String(traced)} detail={`${activeSources} active sources`} tone="#7c3aed" />
      </section>

      <section className="rounded-lg border border-[var(--color-outline-variant)] bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-container)] p-1">
            {(["all", "central", "local"] as const).map((item) => (
              <button key={item} type="button" onClick={() => setBackend(item)} className={`rounded px-3 py-1.5 text-xs font-black capitalize ${backend === item ? "bg-white text-[var(--color-primary)] shadow-sm" : "text-[var(--color-outline)]"}`}>
                {item === "all" ? "All logs" : item === "central" ? "Indexed lake" : "Local tail"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className={data?.backends?.central?.ok ? "text-emerald-700" : "text-amber-700"}>Indexed lake {data?.backends?.central?.ok ? "ready" : "unavailable"}</span>
            <span className={data?.backends?.local?.ok ? "text-emerald-700" : "text-slate-500"}>Local tail {data?.backends?.local?.ok ? "ready" : "not mounted"}</span>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_minmax(220px,0.8fr)_200px_150px_110px]">
          <label className="grid gap-1.5">
            <span className="label-xs text-[var(--color-outline)]"><Search size={12} /> Search query</span>
            <input className="h-10 rounded-md border border-[var(--color-outline-variant)] px-3 text-sm outline-none focus:border-[var(--color-primary)]" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="fetch failed, trace id, service name, exception..." />
          </label>
          <label className="grid gap-1.5">
            <span className="label-xs text-[var(--color-outline)]"><Waypoints size={12} /> Platform trace id</span>
            <input className="h-10 rounded-md border border-[var(--color-outline-variant)] px-3 font-mono text-xs outline-none focus:border-[var(--color-primary)]" value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="Exact trace id" list="platform-log-traces" />
            <datalist id="platform-log-traces">
              {(data?.summary.traceIds ?? []).map((item) => <option key={item} value={item} />)}
            </datalist>
          </label>
          <label className="grid gap-1.5">
            <span className="label-xs text-[var(--color-outline)]"><FileText size={12} /> Source</span>
            <select className="h-10 rounded-md border border-[var(--color-outline-variant)] px-3 text-sm outline-none focus:border-[var(--color-primary)]" value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="all">All sources</option>
              {files.map((file) => <option key={file.source} value={file.source}>{file.source}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5">
            <span className="label-xs text-[var(--color-outline)]"><Filter size={12} /> Level</span>
            <select className="h-10 rounded-md border border-[var(--color-outline-variant)] px-3 text-sm outline-none focus:border-[var(--color-primary)]" value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
              {levels.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5">
            <span className="label-xs text-[var(--color-outline)]"><Activity size={12} /> Limit</span>
            <input className="h-10 rounded-md border border-[var(--color-outline-variant)] px-3 text-sm outline-none focus:border-[var(--color-primary)]" type="number" min={50} max={1500} value={limit} onChange={(event) => setLimit(Number(event.target.value) || 350)} />
          </label>
        </div>
      </section>

      {error && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Could not load logs.</strong>
          <p className="mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
        </section>
      )}

      {data?.message && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {data.message}
        </section>
      )}

      {(data?.warnings ?? []).map((warning) => (
        <section key={warning} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {warning}
        </section>
      ))}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-black text-slate-100">
              <TerminalSquare size={16} /> Live log stream
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Clock size={13} /> {isLoading ? "loading" : `updated ${dateLabel(data?.generatedAt)}`}
            </div>
          </div>
          <div className="max-h-[680px] overflow-auto">
            {rows.length === 0 ? (
              <div className="p-6 text-sm text-slate-400">No matching log lines. Broaden the filters or check whether the selected service has started.</div>
            ) : (
              <table className="w-full border-collapse font-mono text-xs">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-slate-900 hover:bg-slate-900/75">
                      <td className="w-[90px] whitespace-nowrap px-3 py-2 align-top text-slate-500">{row.rawTime ?? (row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : "-")}</td>
                      <td className="w-[92px] whitespace-nowrap px-2 py-2 align-top">
                        <span style={{ color: levelTone(row.level), borderColor: `${levelTone(row.level)}66`, background: `${levelTone(row.level)}18` }} className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide">
                          {row.level}
                        </span>
                      </td>
                      <td className="w-[190px] whitespace-nowrap px-2 py-2 align-top text-cyan-200">
                        {row.source}
                        <span className="ml-1.5 rounded border border-slate-700 px-1 py-0.5 text-[9px] uppercase text-slate-500">{row.backend}</span>
                      </td>
                      <td className="px-3 py-2 align-top leading-5 text-slate-200">
                        <span className="break-words">{row.message}</span>
                        {(row.traceId || row.workflowInstanceId) && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                            {row.traceId && (
                              <Link href={`/audit/trace/${encodeURIComponent(row.traceId)}`} className="inline-flex items-center gap-1 rounded border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-violet-200 no-underline hover:bg-violet-400/20">
                                <Waypoints size={10} /> trace {row.traceId.length > 28 ? `${row.traceId.slice(0, 25)}...` : row.traceId}
                              </Link>
                            )}
                            {row.workflowInstanceId && (
                              <Link href={`/runs/${encodeURIComponent(row.workflowInstanceId)}`} className="inline-flex items-center gap-1 rounded border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 text-cyan-200 no-underline hover:bg-cyan-400/20">
                                run {row.workflowInstanceId.slice(0, 12)}
                              </Link>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-lg border border-[var(--color-outline-variant)] bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 font-black text-[var(--color-text)]">
              <AlertTriangle size={16} /> Error hotspots
            </div>
            <div className="space-y-2">
              {(data?.summary.errorSources ?? []).length === 0 ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">No fatal/error lines in the current view.</div>
              ) : data?.summary.errorSources?.map((item) => (
                <div key={item.source} className="flex items-center justify-between gap-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm">
                  <span className="truncate font-bold text-red-900">{item.source}</span>
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-black text-red-700">{item.count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[var(--color-outline-variant)] bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2 font-black text-[var(--color-text)]">
              <FileText size={16} /> Sources
            </div>
            <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
              {files.map((file) => {
                const count = data?.summary.bySource?.[file.source] ?? 0;
                return (
                  <button key={file.source} type="button" onClick={() => setSource(file.source)} className="w-full rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-container)] px-3 py-2 text-left hover:border-[var(--color-primary)]">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-black text-[var(--color-text)]">{file.source}</span>
                      <span className="text-xs font-bold text-[var(--color-outline)]">{count}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-[var(--color-outline)]">
                      <span>{file.backend === "central" ? "Indexed" : bytesLabel(file.size)}</span>
                      <span>{dateLabel(file.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-[var(--color-outline-variant)] bg-white p-4 text-sm text-[var(--color-outline)] shadow-sm">
            <div className="mb-2 flex items-center gap-2 font-black text-[var(--color-text)]">
              <ShieldCheck size={16} /> Guardrails
            </div>
            Reads only the configured log directory, caps tail size, redacts common secret/token patterns, and links application trace ids to the evidence cockpit before rows reach the browser.
          </section>
        </aside>
      </section>
    </main>
  );
}

function Metric({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-outline-variant)] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-bold text-[var(--color-outline)]">{label}</div>
        <div style={{ color: tone, background: `${tone}14`, border: `1px solid ${tone}30` }} className="grid h-9 w-9 place-items-center rounded-md">
          {icon}
        </div>
      </div>
      <div style={{ color: tone }} className="mt-2 text-2xl font-black">{value}</div>
      <div className="mt-1 truncate text-xs font-bold text-[var(--color-outline)]">{detail}</div>
    </div>
  );
}
