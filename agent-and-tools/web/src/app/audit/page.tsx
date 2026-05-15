"use client";
import { useState } from "react";
import useSWR from "swr";
import { auditGovApi, runtimeApi } from "@/lib/api";
import { ShieldCheck, AlertTriangle, Activity, CheckCircle, XCircle } from "lucide-react";

/**
 * M21 — /audit
 *
 * Operator-facing dashboard for the audit-governance-service:
 *   - Top: summary tiles (events, llm_calls, total_tokens, cost, pending approvals, denials/24h)
 *   - Pending approvals list with one-click approve/reject
 *   - Audit timeline filterable by trace_id / capability_id / actor_id
 */

type Approval = {
  id: string; trace_id?: string; capability_id?: string; tool_name: string;
  tool_args?: Record<string, unknown>; risk_level?: string; requested_at: string;
  status: string; decided_by?: string; decision_reason?: string;
};
type AuditEvent = {
  id: string; trace_id?: string; source_service: string; kind: string;
  subject_type?: string; subject_id?: string; capability_id?: string;
  actor_id?: string; severity: string; payload?: Record<string, unknown>;
  created_at: string;
};

export default function AuditPage() {
  const { data: summary }  = useSWR("audit-summary",   () => auditGovApi.summary(), { refreshInterval: 5_000 });
  const { data: capabilities } = useSWR("audit-capabilities", () => runtimeApi.listCapabilities());
  const { data: pendData, mutate: mutatePend } = useSWR(
    "audit-approvals-pending",
    () => auditGovApi.approvals({ status: "pending" }),
    { refreshInterval: 5_000 },
  );

  const [filter, setFilter] = useState<{ kind: "trace_id" | "capability_id" | "actor_id"; value: string }>({
    kind: "capability_id", value: "",
  });
  const filterKey = filter.value ? `audit-timeline-${filter.kind}-${filter.value}` : null;
  const { data: tlData } = useSWR(filterKey, () => auditGovApi.auditTimeline({ [filter.kind]: filter.value, limit: 100 }));

  const pending = (pendData?.items ?? []) as Approval[];
  const events  = (tlData?.items   ?? []) as AuditEvent[];
  const capabilityOptions = (capabilities ?? []) as Array<Record<string, unknown>>;

  async function decide(id: string, decision: "approved" | "rejected") {
    await auditGovApi.decideApproval(id, { decision, decided_by: "operator", decision_reason: `${decision} via /audit dashboard` });
    await mutatePend();
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Audit & Governance</h1>
        <p className="text-slate-500 mt-1">Cross-service event timeline + pending approvals + ledger summary.</p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
        <Tile icon={Activity}      label="Events"             value={summary?.audit_events ?? 0} />
        <Tile icon={Activity}      label="LLM calls"          value={summary?.llm_calls    ?? 0} />
        <Tile icon={Activity}      label="Total tokens"       value={(summary?.total_tokens_all ?? 0).toLocaleString()} />
        <Tile icon={Activity}      label="Total cost"         value={`$${(summary?.cost_usd_all ?? 0).toFixed(4)}`} />
        <Tile icon={ShieldCheck}   label="Pending approvals"  value={summary?.pending_approvals ?? 0} highlight={(summary?.pending_approvals ?? 0) > 0 ? "amber" : undefined} />
        <Tile icon={AlertTriangle} label="Denials (24h)"      value={summary?.denials_24h ?? 0}      highlight={(summary?.denials_24h ?? 0) > 0 ? "red" : undefined} />
      </div>

      {/* Pending approvals */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Pending approvals ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-400">No approvals waiting.</p>
        ) : (
          <div className="space-y-3">
            {pending.map(a => (
              <div key={a.id} className="card p-4 flex items-start gap-4">
                <div className="p-2.5 bg-amber-50 rounded-lg shrink-0"><ShieldCheck size={18} className="text-amber-600" /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-medium text-slate-900">{a.tool_name}</span>
                    {a.risk_level && <span className="text-[10px] uppercase tracking-wider bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-semibold">{a.risk_level}</span>}
                    {a.capability_id && <code className="text-[10px] text-slate-500">cap={a.capability_id.slice(0,8)}</code>}
                    {a.trace_id && <code className="text-[10px] text-slate-500">trace={a.trace_id.slice(0,12)}</code>}
                  </div>
                  <pre className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1 max-h-24 overflow-auto">{JSON.stringify(a.tool_args ?? {}, null, 2)}</pre>
                  <div className="text-[11px] text-slate-500 mt-1">requested: {new Date(a.requested_at).toLocaleString()}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => decide(a.id, "approved")} className="btn-primary text-xs"><CheckCircle size={14}/> Approve</button>
                  <button onClick={() => decide(a.id, "rejected")} className="btn-secondary text-xs"><XCircle size={14}/> Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Timeline */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Audit timeline</h2>
        <div className="card p-3 mb-3 flex gap-2 items-end flex-wrap">
          <select className="px-2 py-1.5 text-sm border border-slate-200 rounded-md"
            value={filter.kind}
            onChange={e => setFilter({ kind: e.target.value as typeof filter.kind, value: "" })}>
            <option value="capability_id">Capability</option>
            <option value="trace_id">Trace ID</option>
            <option value="actor_id">Actor ID</option>
          </select>
          {filter.kind === "capability_id" ? (
            <select
              className="flex-1 min-w-[260px] px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              value={filter.value}
              onChange={e => setFilter(f => ({ ...f, value: e.target.value }))}
            >
              <option value="">Select capability…</option>
              {capabilityOptions.map(capability => {
                const id = String(capability.id ?? capability.capabilityId ?? capability.capability_id ?? "");
                if (!id) return null;
                const name = String(capability.name ?? capability.capabilityName ?? id);
                const status = capability.status ? ` · ${String(capability.status)}` : "";
                return <option key={id} value={id}>{name}{status}</option>;
              })}
            </select>
          ) : (
            <input className="flex-1 min-w-[260px] px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              placeholder={`Enter ${filter.kind === "trace_id" ? "trace id" : "actor id"} to filter`}
              value={filter.value}
              onChange={e => setFilter(f => ({ ...f, value: e.target.value.trim() }))} />
          )}
        </div>
        {!filter.value ? (
          <p className="text-sm text-slate-400">Enter a value above to load timeline events.</p>
        ) : (
          <div className="space-y-1.5">
            {events.map(e => (
              <div key={e.id} className="card p-3 text-xs flex items-start gap-3">
                <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] ${
                  e.severity === "error" ? "bg-red-100 text-red-700" :
                  e.severity === "warn"  ? "bg-amber-100 text-amber-700" :
                                          "bg-slate-100 text-slate-700"
                }`}>{e.severity}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-slate-500">{e.source_service}</code>
                    <span className="font-medium text-slate-800">{e.kind}</span>
                    {e.subject_type && <code className="text-[10px] text-slate-400">{e.subject_type}/{e.subject_id?.slice(0,8)}</code>}
                  </div>
                  <div className="text-[10px] text-slate-400">{new Date(e.created_at).toLocaleString()}</div>
                  {e.payload && Object.keys(e.payload).length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-slate-600">payload</summary>
                      <pre className="mt-1 bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto text-[10px]">{JSON.stringify(e.payload, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {events.length === 0 && <p className="text-sm text-slate-400">No events for this filter.</p>}
          </div>
        )}
      </section>
    </div>
  );
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
