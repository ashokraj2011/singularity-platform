"use client";
/**
 * M63 Slice F — Per-trace correlation timeline.
 *
 *   /audit/trace/[traceId]
 *
 * Chronological view of every audit_events row that shares the URL
 * trace_id. Designed to answer "what happened during workflow X?"
 * after an operator clicks the "See full trace timeline" link from
 * the M63 Slice E drawer.
 *
 * Differs from /audit:
 *   - Forward time order (oldest → newest) so the operator reads the
 *     run as a story. /audit defaults to newest-first (Splunk-style
 *     "what just happened").
 *   - No filter bar — the trace is the filter. Quick severity / risk
 *     chips at the top are visual scan aids.
 *   - Phase grouping: events with the same source_service render in
 *     a single column band so cross-service hand-offs are visible at
 *     a glance.
 */
import { use, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { auditGovApi, type TraceTimelineRow } from "@/lib/api";
import { ArrowLeft, AlertTriangle, ShieldCheck, Activity } from "lucide-react";

export default function TraceTimelinePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = use(params);
  const decoded = decodeURIComponent(traceId);

  const { data, error, isLoading } = useSWR(
    decoded ? `audit-trace-${decoded}` : null,
    () => auditGovApi.traceTimeline(decoded, 1_000),
  );

  const events: TraceTimelineRow[] = useMemo(() => {
    const items = data?.items ?? [];
    return [...items].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }, [data]);

  // Quick stats for the header bar
  const counts = useMemo(() => {
    const out = { total: 0, errors: 0, warns: 0, highRisk: 0 };
    for (const ev of events) {
      out.total += 1;
      if (ev.level === "error" || ev.level === "fatal") out.errors += 1;
      if (ev.level === "warn") out.warns += 1;
      if (ev.event_type.includes("denied") || ev.event_type.includes("failed") || ev.event_type.includes("conflict")) out.highRisk += 1;
    }
    return out;
  }, [events]);

  if (!decoded) {
    return <p className="text-sm text-slate-400">Missing trace id.</p>;
  }

  return (
    <div>
      <Link
        href="/audit"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-3"
      >
        <ArrowLeft size={14} /> Back to activity log
      </Link>

      <h1 className="text-2xl font-bold text-slate-900">Trace timeline</h1>
      <code className="text-xs text-slate-500 font-mono break-all">{decoded}</code>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-5">
        <Tile icon={Activity}      label="Events"    value={counts.total} />
        <Tile icon={AlertTriangle} label="Errors"    value={counts.errors}  highlight={counts.errors > 0 ? "red" : undefined} />
        <Tile icon={AlertTriangle} label="Warnings"  value={counts.warns}   highlight={counts.warns > 0 ? "amber" : undefined} />
        <Tile icon={ShieldCheck}   label="High risk" value={counts.highRisk} highlight={counts.highRisk > 0 ? "amber" : undefined} />
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading trace…</p>}
      {error && <p className="text-sm text-red-600">Failed to load: {(error as Error).message}</p>}
      {!isLoading && events.length === 0 && (
        <p className="text-sm text-slate-400">No events for this trace.</p>
      )}

      <ol className="space-y-1.5 mt-2">
        {events.map((ev, idx) => {
          // Show source-service column band so cross-service hand-offs
          // are visually obvious. The colour is derived from a stable
          // hash of the service name so workgraph-api is always the
          // same colour across traces.
          const bandHue = hashHue(ev.service);
          const prev = events[idx - 1];
          const isNewService = !prev || prev.service !== ev.service;
          const severityClass =
            ev.level === "fatal" ? "bg-red-700 text-white" :
            ev.level === "error" ? "bg-red-100 text-red-700" :
            ev.level === "warn"  ? "bg-amber-100 text-amber-700" :
                                      "bg-slate-100 text-slate-600";
          const riskBand = ev.level === "fatal" || ev.level === "error" ? "border-l-red-400" :
            ev.level === "warn" ? "border-l-amber-400" :
            ev.source === "log" ? "border-l-blue-300" : "border-l-slate-200";
          return (
            <li key={ev.id} className="flex items-start gap-3">
              <div className="w-24 shrink-0 text-right">
                <div className="text-[11px] text-slate-500 tabular-nums">{new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}</div>
                <div className="text-[9px] text-slate-400">{new Date(ev.ts).toLocaleDateString()}</div>
              </div>
              <div
                className="w-1 self-stretch rounded-full shrink-0"
                style={{ background: `hsl(${bandHue} 70% 60%)` }}
                title={ev.service}
              />
              <div className={`flex-1 min-w-0 card p-2.5 border-l-4 ${riskBand}`}>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {isNewService && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: `hsl(${bandHue} 70% 95%)`, color: `hsl(${bandHue} 70% 35%)` }}>
                      {ev.service}
                    </span>
                  )}
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase ${severityClass}`}>{ev.level}</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{ev.source}</span>
                  <span className="font-medium text-slate-800 text-sm">{ev.event_type}</span>
                </div>
                {ev.message && ev.message !== ev.event_type && (
                  <div className="text-[11px] text-slate-600 mb-1">{ev.message}</div>
                )}
                {ev.payload && Object.keys(ev.payload).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-slate-500">payload</summary>
                    <pre className="mt-1 bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto text-[10px] font-mono leading-relaxed">{JSON.stringify(ev.payload, null, 2)}</pre>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

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
