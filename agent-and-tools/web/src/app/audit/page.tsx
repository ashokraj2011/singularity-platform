"use client";
/**
 * M63 Slice E — Splunk-like activity viewer at /audit.
 *
 * Keeps the existing M21 summary tiles + pending-approvals section
 * (operators still bookmark this route). Replaces the old per-entity
 * timeline with a search-first activity log:
 *
 *   - Top filter bar:  free text + multi-select kind / severity / risk
 *                      + time range + capability/actor/trace pinpoint.
 *   - Quick-filter chips: Errors only · High-risk only · LLM calls ·
 *                         Directory access. One click sets the
 *                         appropriate filter combo.
 *   - Live-tail toggle: opens an EventSource to /audit/stream with the
 *                       current filter. New rows prepend to the list.
 *                       Pause button freezes the view; new rows queue.
 *   - Virtualized row list (just slice(0,500) — 500 rows is plenty for
 *                          the operator scenario; no react-window dep).
 *   - Click row → side drawer with full JSON payload + correlation
 *                 links ("see all events for this trace", "filter by
 *                 this capability", etc.).
 *   - Saved searches in localStorage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { auditGovApi, runtimeApi, type AuditEventRow, type ObservabilityLogRow } from "@/lib/api";
import { OperationsLogExplorer } from "@/components/operations/OperationsLogExplorer";
import {
  Activity, AlertTriangle, CheckCircle, ChevronRight, ChevronLeft,
  Database, FolderSearch, Pause, Play, RefreshCw, Search, ShieldCheck,
  Trash2, XCircle, Zap,
} from "lucide-react";

type Approval = {
  id: string; trace_id?: string; capability_id?: string; tool_name: string;
  tool_args?: Record<string, unknown>; risk_level?: string; requested_at: string;
  status: string; decided_by?: string; decision_reason?: string;
};

type AuditSeverity = "info" | "warn" | "error" | "audit";
type AuditRiskLevel = "low" | "medium" | "high" | "critical";

type SavedSearch = {
  name: string;
  q?: string;
  kinds?: string[];
  severities?: AuditSeverity[];
  riskLevels?: AuditRiskLevel[];
};

const SAVED_SEARCHES_KEY = "m63.savedSearches.v1";
const AUDIT_SEVERITIES = new Set<AuditSeverity>(["info", "warn", "error", "audit"]);
const AUDIT_RISK_LEVELS = new Set<AuditRiskLevel>(["low", "medium", "high", "critical"]);
const RELATIVE_TIMES = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h",  ms: 60 * 60 * 1000 },
  { label: "6h",  ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d",  ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAuditEventRow(value: unknown): value is AuditEventRow {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && nullableString(value.trace_id)
    && typeof value.source_service === "string"
    && typeof value.kind === "string"
    && nullableString(value.subject_type)
    && nullableString(value.subject_id)
    && nullableString(value.actor_id)
    && nullableString(value.capability_id)
    && nullableString(value.tenant_id)
    && typeof value.severity === "string"
    && nullableString(value.risk_level)
    && isRecord(value.payload)
    && typeof value.created_at === "string";
}

function parseAuditEventFrame(raw: string): AuditEventRow | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isAuditEventRow(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedStringArray(value: unknown, maxItems = 20, maxLength = 120): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, maxLength))
      .filter(Boolean),
  )].slice(0, maxItems);
  return values.length ? values : undefined;
}

function normalizedEnumArray<T extends string>(value: unknown, allowed: Set<T>, maxItems = 12): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(value.filter((item): item is T => typeof item === "string" && allowed.has(item as T)))].slice(0, maxItems);
  return values.length ? values : undefined;
}

function normalizeSavedSearch(value: unknown): SavedSearch | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const name = value.name.trim().slice(0, 80);
  if (!name) return null;
  const q = typeof value.q === "string" ? value.q.trim().slice(0, 500) : "";
  return {
    name,
    ...(q ? { q } : {}),
    ...(normalizedStringArray(value.kinds) ? { kinds: normalizedStringArray(value.kinds) } : {}),
    ...(normalizedEnumArray(value.severities, AUDIT_SEVERITIES) ? { severities: normalizedEnumArray(value.severities, AUDIT_SEVERITIES) } : {}),
    ...(normalizedEnumArray(value.riskLevels, AUDIT_RISK_LEVELS) ? { riskLevels: normalizedEnumArray(value.riskLevels, AUDIT_RISK_LEVELS) } : {}),
  };
}

function parseSavedSearches(raw: string | null): SavedSearch[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const byName = new Map<string, SavedSearch>();
    for (const candidate of parsed) {
      const saved = normalizeSavedSearch(candidate);
      if (saved) byName.set(saved.name, saved);
      if (byName.size >= 30) break;
    }
    return [...byName.values()];
  } catch {
    return [];
  }
}

export default function AuditPage() {
  const searchParams = useSearchParams();
  if (searchParams.get("view") === "logs") return <OperationsLogExplorer />;
  return <AuditLedgerPage />;
}

function AuditLedgerPage() {
  const { data: summary } = useSWR("audit-summary", () => auditGovApi.summary(), { refreshInterval: 5_000 });
  const { data: facets }  = useSWR("audit-facets",  () => auditGovApi.auditFacets(), { refreshInterval: 60_000 });
  const { data: logFacets } = useSWR("audit-log-facets", () => auditGovApi.logFacets(), { refreshInterval: 30_000 });
  const { data: logHealth } = useSWR("audit-log-health", () => auditGovApi.logHealth(), { refreshInterval: 10_000 });
  const { data: capabilities } = useSWR("audit-capabilities", () => runtimeApi.listCapabilities());
  const { data: pendData, mutate: mutatePend } = useSWR(
    "audit-approvals-pending",
    () => auditGovApi.approvals({ status: "pending" }),
    { refreshInterval: 5_000 },
  );

  // ── Filter state ─────────────────────────────────────────────────────────
  const [q, setQ] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const [selectedSeverities, setSelectedSeverities] = useState<("info" | "warn" | "error" | "audit")[]>([]);
  const [selectedRisks, setSelectedRisks] = useState<("low" | "medium" | "high" | "critical")[]>([]);
  const [timeRangeMs, setTimeRangeMs] = useState<number | null>(24 * 60 * 60 * 1000);
  const [capabilityId, setCapabilityId] = useState("");
  const [actorId, setActorId] = useState("");
  const [traceId, setTraceId] = useState("");

  // ── Error log state ─────────────────────────────────────────────────────
  const [logQ, setLogQ] = useState("");
  const [logLevels, setLogLevels] = useState<("warn" | "error" | "fatal")[]>(["error", "fatal"]);
  const [logService, setLogService] = useState("");
  const [logTraceId, setLogTraceId] = useState("");
  const [logWorkItemId, setLogWorkItemId] = useState("");
  const [logTimeRangeMs, setLogTimeRangeMs] = useState<number | null>(24 * 60 * 60 * 1000);
  const [logRows, setLogRows] = useState<ObservabilityLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<ObservabilityLogRow | null>(null);

  // ── Live tail state ──────────────────────────────────────────────────────
  const [tailOn, setTailOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pausedBuffer, setPausedBuffer] = useState<AuditEventRow[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  // ── Result state ─────────────────────────────────────────────────────────
  const [rows, setRows] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<AuditEventRow | null>(null);

  // ── Saved searches ───────────────────────────────────────────────────────
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    if (typeof window === "undefined") return [];
    return parseSavedSearches(localStorage.getItem(SAVED_SEARCHES_KEY));
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(savedSearches));
  }, [savedSearches]);

  // ── Resolved filter (memoized) ───────────────────────────────────────────
  const filter = useMemo(() => {
    const since = timeRangeMs ? new Date(Date.now() - timeRangeMs).toISOString() : undefined;
    return {
      q: q.trim() || undefined,
      kinds: selectedKinds.length > 0 ? selectedKinds : undefined,
      severities: selectedSeverities.length > 0 ? selectedSeverities : undefined,
      riskLevels: selectedRisks.length > 0 ? selectedRisks : undefined,
      capabilityId: capabilityId || undefined,
      actorId: actorId || undefined,
      traceId: traceId || undefined,
      since,
    };
  }, [q, selectedKinds, selectedSeverities, selectedRisks, timeRangeMs, capabilityId, actorId, traceId]);

  const logFilter = useMemo(() => {
    const since = logTimeRangeMs ? new Date(Date.now() - logTimeRangeMs).toISOString() : undefined;
    return {
      q: logQ.trim() || undefined,
      levels: logLevels.length > 0 ? logLevels : undefined,
      services: logService ? [logService] : undefined,
      traceId: logTraceId || undefined,
      workItemId: logWorkItemId || undefined,
      since,
    };
  }, [logQ, logLevels, logService, logTraceId, logWorkItemId, logTimeRangeMs]);

  // ── Search action ────────────────────────────────────────────────────────
  const runSearch = useCallback(async (append = false) => {
    setLoading(true);
    setSearchError(null);
    try {
      const res = await auditGovApi.auditSearch({
        ...filter,
        limit: 100,
        cursor: append ? nextCursor ?? undefined : undefined,
      });
      setRows(prev => append ? [...prev, ...res.items] : res.items);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setSearchError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, nextCursor]);

  const runLogSearch = useCallback(async (append = false) => {
    setLogLoading(true);
    setLogError(null);
    try {
      const res = await auditGovApi.logSearch({
        ...logFilter,
        limit: 100,
        cursor: append ? logNextCursor ?? undefined : undefined,
      });
      setLogRows(prev => append ? [...prev, ...res.items] : res.items);
      setLogNextCursor(res.nextCursor);
    } catch (err) {
      setLogError((err as Error).message);
    } finally {
      setLogLoading(false);
    }
  }, [logFilter, logNextCursor]);

  // Auto-search on filter change (debounced). Skip when tail is on —
  // the operator's looking at live data, not a static result set.
  useEffect(() => {
    if (tailOn) return;
    const t = setTimeout(() => { void runSearch(false); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, selectedKinds, selectedSeverities, selectedRisks, timeRangeMs, capabilityId, actorId, traceId, tailOn]);

  useEffect(() => {
    const t = setTimeout(() => { void runLogSearch(false); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logQ, logLevels, logService, logTraceId, logWorkItemId, logTimeRangeMs]);

  // ── Live tail wiring ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!tailOn) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      return;
    }
    const url = auditGovApi.auditStreamUrl({
      kinds: filter.kinds,
      severities: filter.severities,
      riskLevels: filter.riskLevels,
      capabilityId: filter.capabilityId,
      actorId: filter.actorId,
      traceId: filter.traceId,
    });
    const es = new EventSource(url);
    eventSourceRef.current = es;
    es.addEventListener("audit", (ev) => {
      const data = parseAuditEventFrame((ev as MessageEvent).data);
      if (!data) return;
      // Paused: buffer; otherwise prepend (cap at 500 to keep memory bounded).
      setPaused(currentPaused => {
        if (currentPaused) {
          setPausedBuffer(buf => [data, ...buf].slice(0, 500));
        } else {
          setRows(prev => [data, ...prev].slice(0, 500));
        }
        return currentPaused;
      });
    });
    es.onerror = () => {
      // Browser will auto-reconnect; we just surface the state.
      // eslint-disable-next-line no-console
      console.warn("[audit-tail] EventSource error — will auto-reconnect");
    };
    return () => { es.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailOn, filter.kinds?.join(","), filter.severities?.join(","), filter.riskLevels?.join(","), filter.capabilityId, filter.actorId, filter.traceId]);

  // Drain paused buffer when un-pausing.
  useEffect(() => {
    if (!paused && pausedBuffer.length > 0) {
      setRows(prev => [...pausedBuffer, ...prev].slice(0, 500));
      setPausedBuffer([]);
    }
  }, [paused, pausedBuffer]);

  // ── Quick filters ────────────────────────────────────────────────────────
  const quickFilters: Array<{ label: string; icon: React.ElementType; apply: () => void; active: () => boolean }> = [
    {
      label: "Errors only", icon: AlertTriangle,
      apply: () => { setSelectedSeverities(["error", "warn"]); setSelectedRisks([]); setSelectedKinds([]); },
      active: () => selectedSeverities.includes("error") && selectedKinds.length === 0,
    },
    {
      label: "High-risk only", icon: ShieldCheck,
      apply: () => { setSelectedRisks(["high", "critical"]); setSelectedSeverities([]); setSelectedKinds([]); },
      active: () => selectedRisks.includes("high") && selectedKinds.length === 0,
    },
    {
      label: "LLM calls", icon: Zap,
      apply: () => { setSelectedKinds(["llm.call.completed"]); setSelectedSeverities([]); setSelectedRisks([]); },
      active: () => selectedKinds.length === 1 && selectedKinds[0] === "llm.call.completed",
    },
    {
      label: "Directory access", icon: FolderSearch,
      apply: () => {
        setSelectedKinds(["tool.filesystem.access", "tool.filesystem.access.sensitive"]);
        setSelectedSeverities([]); setSelectedRisks([]);
      },
      active: () => selectedKinds.includes("tool.filesystem.access"),
    },
  ];

  // ── Approval decision ────────────────────────────────────────────────────
  async function decide(id: string, decision: "approved" | "rejected") {
    await auditGovApi.decideApproval(id, { decision, decided_by: "operator", decision_reason: `${decision} via /audit dashboard` });
    await mutatePend();
  }

  const pending = (pendData?.items ?? []) as Approval[];
  const capabilityOptions = (capabilities ?? []) as Array<Record<string, unknown>>;
  const errorLogCounts = useMemo(() => {
    const out = { fatal: 0, error: 0, warn: 0 };
    for (const row of logRows) {
      if (row.level === "fatal") out.fatal += 1;
      if (row.level === "error") out.error += 1;
      if (row.level === "warn") out.warn += 1;
    }
    return out;
  }, [logRows]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit & Activity</h1>
          <p className="text-slate-500 mt-1">Governance events, approvals, and operational activity in one evidence surface.</p>
        </div>
        <Link href="/audit?view=logs" className="btn-secondary text-xs">
          Open full log explorer
        </Link>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
        <Tile icon={Activity}      label="Events"            value={summary?.audit_events ?? 0} />
        <Tile icon={Activity}      label="LLM calls"         value={summary?.llm_calls ?? 0} />
        <Tile icon={Activity}      label="Total tokens"      value={(summary?.total_tokens_all ?? 0).toLocaleString()} />
        <Tile icon={Activity}      label="Total cost"        value={`$${(summary?.cost_usd_all ?? 0).toFixed(4)}`} />
        <Tile icon={ShieldCheck}   label="Pending approvals" value={summary?.pending_approvals ?? 0} highlight={(summary?.pending_approvals ?? 0) > 0 ? "amber" : undefined} />
        <Tile icon={AlertTriangle} label="Denials (24h)"     value={summary?.denials_24h ?? 0}      highlight={(summary?.denials_24h ?? 0) > 0 ? "red" : undefined} />
      </div>

      {/* Pending approvals (kept from M21) */}
      {pending.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Pending approvals ({pending.length})</h2>
          <div className="space-y-3">
            {pending.slice(0, 6).map(a => (
              <div key={a.id} className="card p-4 flex items-start gap-4">
                <div className="p-2.5 bg-amber-50 rounded-lg shrink-0"><ShieldCheck size={18} className="text-amber-600" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-medium text-slate-900">{a.tool_name}</span>
                    {a.risk_level && <span className="text-[10px] uppercase tracking-wider bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-semibold">{a.risk_level}</span>}
                    {a.capability_id && <code className="text-[10px] text-slate-500">cap={a.capability_id.slice(0, 8)}</code>}
                    {a.trace_id && <code className="text-[10px] text-slate-500">trace={a.trace_id.slice(0, 12)}</code>}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">requested: {new Date(a.requested_at).toLocaleString()}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => decide(a.id, "approved")} className="btn-primary text-xs"><CheckCircle size={14} /> Approve</button>
                  <button onClick={() => decide(a.id, "rejected")} className="btn-secondary text-xs"><XCircle size={14} /> Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error console */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Error console</h2>
            <p className="text-xs text-slate-500">Operational logs from the new log lake, optimized for debugging failed stages and stuck WorkItems.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-500 flex items-center gap-1">
              <Database size={12} />
              {logHealth?.storage.backend ?? "storage"} · {logHealth?.storage.path ?? logHealth?.storage.bucket ?? "not ready"}
            </span>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
              onClick={() => void runLogSearch(false)}
              disabled={logLoading}
            >
              <RefreshCw size={13} className={logLoading ? "animate-spin" : ""} /> Refresh errors
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Tile icon={AlertTriangle} label="Fatal" value={errorLogCounts.fatal} highlight={errorLogCounts.fatal > 0 ? "red" : undefined} />
          <Tile icon={AlertTriangle} label="Errors" value={errorLogCounts.error} highlight={errorLogCounts.error > 0 ? "red" : undefined} />
          <Tile icon={AlertTriangle} label="Warnings" value={errorLogCounts.warn} highlight={errorLogCounts.warn > 0 ? "amber" : undefined} />
          <Tile icon={Database} label="Stored logs" value={(logHealth?.ingested_count ?? 0).toLocaleString()} />
        </div>

        <div className="card p-3 mb-3 space-y-3">
          <div className="flex items-center gap-2">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded-md font-mono"
              placeholder='Search error logs — e.g. "workspace locked", timeout, anthropic, context-fabric'
              value={logQ}
              onChange={e => setLogQ(e.target.value)}
            />
            {logQ && <button onClick={() => setLogQ("")} className="text-slate-400 hover:text-slate-600"><XCircle size={14} /></button>}
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Level</span>
            {(["fatal", "error", "warn"] as const).map(level => {
              const active = logLevels.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  className={`text-xs px-2.5 py-1 rounded-md border uppercase ${active ? "bg-red-50 border-red-200 text-red-700" : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                  onClick={() => setLogLevels(prev => active ? prev.filter(v => v !== level) as typeof prev : [...prev, level])}
                >{level}</button>
              );
            })}
            <button
              type="button"
              className="text-xs px-2.5 py-1 rounded-md border bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
              onClick={() => setLogLevels(["warn", "error", "fatal"])}
            >Warnings + errors</button>
            <button
              type="button"
              className="text-xs px-2.5 py-1 rounded-md border bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
              onClick={() => setLogLevels([])}
            >All levels</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-2">
            <select
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md"
              value={logService}
              onChange={e => setLogService(e.target.value)}
            >
              <option value="">All services</option>
              {(logFacets?.services ?? []).map(service => (
                <option key={service.service} value={service.service}>{service.service} ({service.count})</option>
              ))}
            </select>
            <input
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md font-mono lg:col-span-2"
              placeholder="trace_id"
              value={logTraceId}
              onChange={e => setLogTraceId(e.target.value.trim())}
            />
            <input
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
              placeholder="work_item_id"
              value={logWorkItemId}
              onChange={e => setLogWorkItemId(e.target.value.trim())}
            />
            <select
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md"
              value={String(logTimeRangeMs)}
              onChange={e => setLogTimeRangeMs(e.target.value === "all" ? null : Number(e.target.value))}
            >
              <option value={15 * 60 * 1000}>Last 15m</option>
              <option value={60 * 60 * 1000}>Last 1h</option>
              <option value={24 * 60 * 60 * 1000}>Last 24h</option>
              <option value={7 * 24 * 60 * 60 * 1000}>Last 7d</option>
              <option value="all">All time</option>
            </select>
          </div>
        </div>

        {logError && (
          <div className="card p-3 mb-3 bg-red-50 border-red-200 text-red-800 text-sm">
            Error-log search failed: {logError}
          </div>
        )}

        <div className="space-y-1">
          {logRows.slice(0, 100).map(log => (
            <LogRowItem key={log.id} row={log} onClick={() => setSelectedLog(log)} />
          ))}
          {logRows.length === 0 && !logLoading && (
            <p className="text-sm text-slate-400 p-6 text-center border border-dashed border-slate-200 rounded-lg">
              No operational logs match this filter yet. Services need to emit to <code>/api/v1/logs</code> for richer diagnostics.
            </p>
          )}
        </div>
        {logNextCursor && (
          <div className="text-center mt-3">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => void runLogSearch(true)}
              disabled={logLoading}
            >Load more logs</button>
          </div>
        )}
      </section>

      {/* Activity log */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900">Activity log</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`text-xs px-3 py-1.5 rounded-md border flex items-center gap-1.5 ${tailOn ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
              onClick={() => { setTailOn(v => !v); setPaused(false); setPausedBuffer([]); }}
              title="Stream new events live via Server-Sent Events"
            >
              <Activity size={13} /> {tailOn ? "Live" : "Live tail"}
            </button>
            {tailOn && (
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded-md border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
                onClick={() => setPaused(p => !p)}
                title={paused ? `Resume (${pausedBuffer.length} buffered)` : "Pause incoming events"}
              >
                {paused ? <><Play size={13} /> Resume{pausedBuffer.length > 0 ? ` (${pausedBuffer.length})` : ""}</> : <><Pause size={13} /> Pause</>}
              </button>
            )}
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded-md border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
              onClick={() => void runSearch(false)}
              disabled={loading}
              title="Re-run the current search"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="card p-3 mb-3 space-y-3">
          <div className="flex items-center gap-2">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded-md font-mono"
              placeholder='Free text — e.g. "code_change" OR "error" -test  (Postgres FTS websearch syntax)'
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            {q && <button onClick={() => setQ("")} className="text-slate-400 hover:text-slate-600"><XCircle size={14} /></button>}
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Time</span>
            {RELATIVE_TIMES.map(rt => (
              <button
                key={rt.label}
                type="button"
                className={`text-xs px-2.5 py-1 rounded-md border ${timeRangeMs === rt.ms ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                onClick={() => setTimeRangeMs(rt.ms)}
              >{rt.label}</button>
            ))}
            <button
              type="button"
              className={`text-xs px-2.5 py-1 rounded-md border ${timeRangeMs === null ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
              onClick={() => setTimeRangeMs(null)}
            >All</button>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Quick</span>
            {quickFilters.map(qf => {
              const active = qf.active();
              return (
                <button
                  key={qf.label}
                  type="button"
                  className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-1 ${active ? "bg-singularity-50 border-singularity-300 text-singularity-700" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  onClick={qf.apply}
                >
                  <qf.icon size={12} /> {qf.label}
                </button>
              );
            })}
            <button
              type="button"
              className="text-xs px-2.5 py-1 rounded-md border bg-white border-slate-200 text-slate-500 hover:bg-slate-50 ml-auto"
              onClick={() => {
                setQ(""); setSelectedKinds([]); setSelectedSeverities([]); setSelectedRisks([]);
                setCapabilityId(""); setActorId(""); setTraceId("");
              }}
            >Clear all</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
            <Multiselect
              label="Kind"
              options={(facets?.kinds ?? []).map(k => ({ value: k.kind, label: `${k.kind}`, count: k.count }))}
              selected={selectedKinds}
              onChange={setSelectedKinds}
            />
            <Multiselect
              label="Severity"
              options={(facets?.severities ?? []).map(s => ({ value: s.severity, label: s.severity, count: s.count }))}
              selected={selectedSeverities}
              onChange={(v) => setSelectedSeverities(v as ("info" | "warn" | "error" | "audit")[])}
            />
            <Multiselect
              label="Risk"
              options={(facets?.riskLevels ?? []).map(r => ({ value: r.risk_level, label: r.risk_level, count: r.count }))}
              selected={selectedRisks}
              onChange={(v) => setSelectedRisks(v as ("low" | "medium" | "high" | "critical")[])}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
            <select
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md"
              value={capabilityId}
              onChange={e => setCapabilityId(e.target.value)}
            >
              <option value="">All capabilities</option>
              {capabilityOptions.map(c => {
                const id = String(c.id ?? c.capabilityId ?? c.capability_id ?? "");
                if (!id) return null;
                const name = String(c.name ?? c.capabilityName ?? id);
                return <option key={id} value={id}>{name}</option>;
              })}
            </select>
            <input
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
              placeholder="actor_id (optional)"
              value={actorId}
              onChange={e => setActorId(e.target.value.trim())}
            />
            <input
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md font-mono"
              placeholder="trace_id (optional)"
              value={traceId}
              onChange={e => setTraceId(e.target.value.trim())}
            />
          </div>

          {/* Saved searches */}
          <div className="flex flex-wrap gap-2 items-center pt-1 border-t border-slate-100">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Saved</span>
            {savedSearches.length === 0 && <span className="text-[11px] text-slate-400 italic">No saved searches</span>}
            {savedSearches.map(s => (
              <span key={s.name} className="text-xs px-2 py-1 rounded-md border bg-white border-slate-200 text-slate-600 flex items-center gap-1">
                <button
                  type="button"
                  className="hover:text-slate-900"
                  onClick={() => {
                    setQ(s.q ?? "");
                    setSelectedKinds(s.kinds ?? []);
                    setSelectedSeverities(s.severities ?? []);
                    setSelectedRisks(s.riskLevels ?? []);
                  }}
                >{s.name}</button>
                <button
                  type="button"
                  className="text-slate-400 hover:text-red-500"
                  onClick={() => setSavedSearches(prev => prev.filter(x => x.name !== s.name))}
                  aria-label={`Delete saved search ${s.name}`}
                ><Trash2 size={11} /></button>
              </span>
            ))}
            <button
              type="button"
              className="text-xs px-2 py-1 rounded-md border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50"
              onClick={() => {
                const name = window.prompt("Saved-search name:");
                const normalizedName = name?.trim().slice(0, 80);
                if (!normalizedName) return;
                setSavedSearches(prev => {
                  const next = prev.filter(x => x.name !== normalizedName);
                  next.push({
                    name: normalizedName,
                    q: q.trim() || undefined,
                    kinds: normalizedStringArray(selectedKinds),
                    severities: normalizedEnumArray(selectedSeverities, AUDIT_SEVERITIES),
                    riskLevels: normalizedEnumArray(selectedRisks, AUDIT_RISK_LEVELS),
                  });
                  return next;
                });
              }}
            >+ Save current</button>
          </div>
        </div>

        {/* Results */}
        {searchError && (
          <div className="card p-3 mb-3 bg-red-50 border-red-200 text-red-800 text-sm">
            Search failed: {searchError}
          </div>
        )}
        <div className="text-[11px] text-slate-500 mb-2">
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {nextCursor && <> · more available</>}
          {tailOn && !paused && <> · <span className="text-emerald-600">●</span> tailing</>}
          {tailOn && paused && <> · <span className="text-amber-600">▌▌</span> paused ({pausedBuffer.length} buffered)</>}
        </div>

        <div className="space-y-1">
          {rows.slice(0, 500).map(ev => (
            <RowItem key={ev.id} row={ev} onClick={() => setSelectedRow(ev)} />
          ))}
          {rows.length === 0 && !loading && (
            <p className="text-sm text-slate-400 p-6 text-center">No events match this filter.</p>
          )}
        </div>

        {nextCursor && !tailOn && (
          <div className="text-center mt-3">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => void runSearch(true)}
              disabled={loading}
            >Load more</button>
          </div>
        )}
      </section>

      {/* Drawer */}
      {selectedRow && (
        <EventDrawer
          event={selectedRow}
          onClose={() => setSelectedRow(null)}
          onFilterByCapability={(id) => { setCapabilityId(id); setSelectedRow(null); }}
          onFilterByActor={(id) => { setActorId(id); setSelectedRow(null); }}
        />
      )}
      {selectedLog && (
        <LogDrawer
          log={selectedLog}
          onClose={() => setSelectedLog(null)}
          onFilterTrace={(id) => { setLogTraceId(id); setSelectedLog(null); }}
          onFilterWorkItem={(id) => { setLogWorkItemId(id); setSelectedLog(null); }}
          onFilterService={(service) => { setLogService(service); setSelectedLog(null); }}
        />
      )}
    </div>
  );
}

// ── Row component ──────────────────────────────────────────────────────────

function RowItem({ row, onClick }: { row: AuditEventRow; onClick: () => void }) {
  const severityClass =
    row.severity === "error" ? "bg-red-100 text-red-700" :
    row.severity === "warn"  ? "bg-amber-100 text-amber-700" :
    row.severity === "audit" ? "bg-purple-100 text-purple-700" :
                               "bg-slate-100 text-slate-600";
  const riskClass = !row.risk_level ? "" :
    row.risk_level === "critical" ? "bg-red-50 border-red-300 text-red-700" :
    row.risk_level === "high"     ? "bg-amber-50 border-amber-300 text-amber-700" :
    row.risk_level === "medium"   ? "bg-yellow-50 border-yellow-200 text-yellow-700" :
                                    "bg-slate-50 border-slate-200 text-slate-500";

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left card p-2.5 hover:border-slate-300 transition-colors"
    >
      <div className="flex items-start gap-3 text-xs">
        <span className="text-[10px] text-slate-400 w-24 shrink-0 font-mono tabular-nums">
          {new Date(row.created_at).toLocaleTimeString(undefined, { hour12: false })}
        </span>
        <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] ${severityClass}`}>{row.severity}</span>
        {row.risk_level && (
          <span className={`shrink-0 px-1.5 py-0.5 rounded border font-mono text-[10px] uppercase ${riskClass}`}>{row.risk_level}</span>
        )}
        <span className="text-slate-500 text-[10px] font-mono w-28 shrink-0 truncate">{row.source_service}</span>
        <span className="font-medium text-slate-800 flex-1 truncate">{row.kind}</span>
        {row.subject_type && (
          <code className="text-[10px] text-slate-400 truncate max-w-[180px]">{row.subject_type}/{row.subject_id?.slice(0, 8) ?? ""}</code>
        )}
        <ChevronRight size={12} className="text-slate-300 shrink-0" />
      </div>
    </button>
  );
}

function LogRowItem({ row, onClick }: { row: ObservabilityLogRow; onClick: () => void }) {
  const levelClass =
    row.level === "fatal" ? "bg-red-700 text-white" :
    row.level === "error" ? "bg-red-100 text-red-700" :
    row.level === "warn"  ? "bg-amber-100 text-amber-700" :
                             "bg-slate-100 text-slate-600";
  const message = row.message || row.event_type || "log";
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left card p-3 hover:border-red-200 hover:bg-red-50/30 transition-colors"
    >
      <div className="flex items-start gap-3 text-xs">
        <span className="text-[10px] text-slate-400 w-24 shrink-0 font-mono tabular-nums">
          {new Date(row.ts).toLocaleTimeString(undefined, { hour12: false })}
        </span>
        <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] uppercase ${levelClass}`}>{row.level}</span>
        <span className="text-slate-500 text-[10px] font-mono w-36 shrink-0 truncate">{row.service}</span>
        <span className="font-medium text-slate-900 flex-1 truncate">{message}</span>
        {row.stage_key && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{row.stage_key}</span>}
        {row.trace_id && <code className="text-[10px] text-slate-400 truncate max-w-[180px]">trace={row.trace_id}</code>}
        <ChevronRight size={12} className="text-slate-300 shrink-0" />
      </div>
      {(row.event_type || row.work_item_id || row.tool_name || row.model) && (
        <div className="mt-1 ml-[8.25rem] flex items-center gap-2 text-[10px] text-slate-400 font-mono flex-wrap">
          {row.event_type && <span>{row.event_type}</span>}
          {row.work_item_id && <span>workItem={row.work_item_id}</span>}
          {row.tool_name && <span>tool={row.tool_name}</span>}
          {row.model && <span>model={row.model}</span>}
        </div>
      )}
    </button>
  );
}

// ── Drawer component ──────────────────────────────────────────────────────

function EventDrawer({
  event, onClose, onFilterByCapability, onFilterByActor,
}: {
  event: AuditEventRow;
  onClose: () => void;
  onFilterByCapability: (id: string) => void;
  onFilterByActor: (id: string) => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-white shadow-2xl z-50 flex flex-col">
        <header className="border-b border-slate-200 p-4 flex items-center gap-2">
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded"><ChevronLeft size={18} /></button>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-slate-900 truncate">{event.kind}</div>
            <div className="text-[11px] text-slate-500 font-mono">{event.id}</div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <DefList items={[
            ["Time",          new Date(event.created_at).toISOString()],
            ["Source",        event.source_service],
            ["Severity",      event.severity],
            ["Risk",          event.risk_level ?? "—"],
            ["Subject",       event.subject_type ? `${event.subject_type} / ${event.subject_id}` : "—"],
            ["Capability",    event.capability_id ?? "—"],
            ["Actor",         event.actor_id ?? "—"],
            ["Trace",         event.trace_id ?? "—"],
          ]} />

          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">Correlation</div>
            <div className="flex flex-wrap gap-2">
              {event.trace_id && (
                <Link
                  href={`/audit/trace/${encodeURIComponent(event.trace_id)}`}
                  className="text-xs px-2 py-1 rounded-md border border-singularity-200 bg-singularity-50 text-singularity-700 hover:bg-singularity-100"
                >
                  See full trace timeline →
                </Link>
              )}
              {event.capability_id && (
                <button
                  className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  onClick={() => onFilterByCapability(event.capability_id!)}
                >Filter by this capability</button>
              )}
              {event.actor_id && (
                <button
                  className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  onClick={() => onFilterByActor(event.actor_id!)}
                >Filter by this actor</button>
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">Payload</div>
            <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-3 overflow-auto font-mono leading-relaxed">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}

function LogDrawer({
  log, onClose, onFilterTrace, onFilterWorkItem, onFilterService,
}: {
  log: ObservabilityLogRow;
  onClose: () => void;
  onFilterTrace: (id: string) => void;
  onFilterWorkItem: (id: string) => void;
  onFilterService: (service: string) => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-white shadow-2xl z-50 flex flex-col">
        <header className="border-b border-slate-200 p-4 flex items-center gap-2">
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded"><ChevronLeft size={18} /></button>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-slate-900 truncate">{log.message || log.event_type || "Operational log"}</div>
            <div className="text-[11px] text-slate-500 font-mono">{log.id}</div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <DefList items={[
            ["Time", new Date(log.ts).toISOString()],
            ["Service", log.service],
            ["Level", log.level],
            ["Event type", log.event_type ?? "—"],
            ["Trace", log.trace_id ?? "—"],
            ["WorkItem", log.work_item_id ?? "—"],
            ["Workflow", log.workflow_instance_id ?? "—"],
            ["Stage", log.stage_key ?? "—"],
            ["Tool", log.tool_name ?? "—"],
            ["Model", log.model ?? "—"],
            ["Raw storage", log.raw_storage_uri ?? "—"],
          ]} />

          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">Actions</div>
            <div className="flex flex-wrap gap-2">
              {log.trace_id && (
                <Link
                  href={`/audit/trace/${encodeURIComponent(log.trace_id)}`}
                  className="text-xs px-2 py-1 rounded-md border border-singularity-200 bg-singularity-50 text-singularity-700 hover:bg-singularity-100"
                >
                  Open combined trace timeline →
                </Link>
              )}
              {log.trace_id && (
                <button
                  className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  onClick={() => onFilterTrace(log.trace_id!)}
                >Filter this trace</button>
              )}
              {log.work_item_id && (
                <button
                  className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  onClick={() => onFilterWorkItem(log.work_item_id!)}
                >Filter this WorkItem</button>
              )}
              <button
                className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                onClick={() => onFilterService(log.service)}
              >Filter this service</button>
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">Payload</div>
            <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-3 overflow-auto font-mono leading-relaxed">
              {JSON.stringify(log.payload, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}

function DefList({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400 col-span-1">{k}</dt>
          <dd className="col-span-2 text-slate-800 font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Multi-select helper ────────────────────────────────────────────────────

function Multiselect({ label, options, selected, onChange }: {
  label: string;
  options: Array<{ value: string; label: string; count?: number }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className="w-full text-left px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white flex items-center justify-between hover:bg-slate-50"
        onClick={() => setOpen(o => !o)}
      >
        <span className="truncate">
          <span className="text-slate-400">{label}: </span>
          <span className="text-slate-800">
            {selected.length === 0 ? "All" : selected.length === 1 ? selected[0] : `${selected.length} selected`}
          </span>
        </span>
        <ChevronRight size={12} className={`text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-72 overflow-auto bg-white border border-slate-200 rounded-md shadow-lg p-1">
          {options.length === 0 ? (
            <p className="text-[11px] text-slate-400 p-2">No options</p>
          ) : (
            options.map(opt => {
              const isSelected = selected.includes(opt.value);
              return (
                <label key={opt.value} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      onChange(isSelected ? selected.filter(s => s !== opt.value) : [...selected, opt.value]);
                    }}
                  />
                  <span className="flex-1 font-mono truncate">{opt.label}</span>
                  {typeof opt.count === "number" && <span className="text-[10px] text-slate-400 tabular-nums">{opt.count}</span>}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Summary tile ───────────────────────────────────────────────────────────

function Tile({ icon: Icon, label, value, highlight }: { icon: React.ElementType; label: string; value: string | number; highlight?: "amber" | "red" }) {
  const colour =
    highlight === "amber" ? "bg-amber-50 border-amber-200 text-amber-800" :
    highlight === "red"   ? "bg-red-50 border-red-200 text-red-800" :
                            "bg-white border-slate-200 text-slate-800";
  return (
    <div className={`border rounded-lg p-3 ${colour}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider opacity-80">
        <Icon size={11} /> {label}
      </div>
      <div className="text-xl font-bold mt-1">{value}</div>
    </div>
  );
}
