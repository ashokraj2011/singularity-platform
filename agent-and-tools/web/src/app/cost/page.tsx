"use client";
import { useState } from "react";
import useSWR from "swr";
import { auditGovApi } from "@/lib/api";
import { DollarSign, Activity, Cpu, TrendingUp } from "lucide-react";

/**
 * M21 — /cost
 *
 * Cost dashboard backed by audit-governance-service:
 *   - Summary tiles (total cost, total tokens, llm calls)
 *   - Daily / hourly / weekly cost rollup, optionally filtered by capability_id
 *   - Top models by cost over a window
 */

type Bucket = { bucket: string; calls: number; total_tokens: number; cost_usd: number; input_tokens: number; output_tokens: number };
type ModelRow = { provider: string; model: string; calls: number; total_tokens: number; cost_usd: number };

export default function CostPage() {
  const [period, setPeriod] = useState<"hour" | "day" | "week">("day");
  const [capabilityId, setCapabilityId] = useState("");
  const [days, setDays] = useState(7);

  const { data: summary } = useSWR("cost-summary", () => auditGovApi.summary(), { refreshInterval: 10_000 });
  const { data: rollupData } = useSWR(
    `cost-rollup-${period}-${capabilityId}`,
    () => auditGovApi.costRollup({ period, capability_id: capabilityId || undefined, limit: 30 }),
    { refreshInterval: 10_000 },
  );
  const { data: modelData } = useSWR(
    `cost-by-model-${days}-${capabilityId}`,
    () => auditGovApi.costByModel({ days, capability_id: capabilityId || undefined }),
    { refreshInterval: 10_000 },
  );

  const buckets = (rollupData?.buckets ?? []) as Bucket[];
  const models  = (modelData?.items   ?? []) as ModelRow[];

  const maxBucketCost = Math.max(0.0001, ...buckets.map(b => b.cost_usd));
  const totalCost = summary?.cost_usd_all ?? 0;
  const totalTokens = summary?.total_tokens_all ?? 0;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Cost & Usage</h1>
        <p className="text-slate-500 mt-1">All-time spend rollup with per-capability and per-model breakdowns.</p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <Tile icon={DollarSign} label="Total cost"    value={`$${totalCost.toFixed(4)}`} />
        <Tile icon={Cpu}        label="Total tokens"  value={totalTokens.toLocaleString()} />
        <Tile icon={Activity}   label="LLM calls"     value={summary?.llm_calls ?? 0} />
        <Tile icon={TrendingUp} label="Audit events"  value={summary?.audit_events ?? 0} />
      </div>

      {/* Filters */}
      <div className="card p-3 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Bucket</label>
          <select className="px-2 py-1.5 text-sm border border-slate-200 rounded-md"
            value={period} onChange={e => setPeriod(e.target.value as typeof period)}>
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">By-model window (days)</label>
          <select className="px-2 py-1.5 text-sm border border-slate-200 rounded-md"
            value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={1}>1</option>
            <option value={7}>7</option>
            <option value={30}>30</option>
            <option value={90}>90</option>
          </select>
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">capability_id (optional)</label>
          <input className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md font-mono"
            placeholder="leave blank for all capabilities"
            value={capabilityId} onChange={e => setCapabilityId(e.target.value.trim())} />
        </div>
      </div>

      {/* Spend over time */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Spend by {period} ({buckets.length} bucket{buckets.length === 1 ? "" : "s"})</h2>
        {buckets.length === 0 ? (
          <p className="text-sm text-slate-400">No spend recorded yet for this filter.</p>
        ) : (
          <div className="card p-4 space-y-1.5">
            {buckets.map(b => (
              <div key={b.bucket} className="flex items-center gap-3 text-xs">
                <div className="w-32 shrink-0 font-mono text-slate-600">{new Date(b.bucket).toLocaleString()}</div>
                <div className="flex-1 bg-slate-100 rounded h-5 relative overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full"
                    style={{ width: `${(b.cost_usd / maxBucketCost) * 100}%` }}
                  />
                  <div className="absolute inset-0 flex items-center px-2 text-[10px] text-slate-700 mix-blend-multiply">
                    {b.calls} calls · {b.total_tokens.toLocaleString()} tok
                  </div>
                </div>
                <div className="w-24 shrink-0 text-right font-mono text-slate-900 font-semibold">${b.cost_usd.toFixed(4)}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Top models */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Top models (last {days} day{days === 1 ? "" : "s"})</h2>
        {models.length === 0 ? (
          <p className="text-sm text-slate-400">No model usage recorded for this window.</p>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-slate-700">Provider</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-700">Model</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-700">Calls</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-700">Tokens</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-700">Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={`${m.provider}-${m.model}-${i}`} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-3 py-2 font-mono text-slate-600">{m.provider}</td>
                    <td className="px-3 py-2 font-mono text-slate-800">{m.model}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{m.calls.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-slate-700">{m.total_tokens.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-900 font-semibold">${m.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | number }) {
  return (
    <div className="border border-slate-200 bg-white rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <Icon size={11} /> {label}
      </div>
      <div className="text-xl font-bold mt-1 text-slate-900">{value}</div>
    </div>
  );
}
