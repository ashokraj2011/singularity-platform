"use client";
import { useState } from "react";
import useSWR from "swr";
import { ScrollText, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const SCOPE_TYPES = ["PLATFORM", "TENANT", "BUSINESS_UNIT", "CAPABILITY", "AGENT_TEMPLATE", "AGENT_BINDING", "WORKFLOW", "WORKFLOW_PHASE", "EXECUTION"];
const LAYER_TYPES = [
  "PLATFORM_CONSTITUTION", "TENANT_CONTEXT", "BUSINESS_UNIT_CONTEXT", "AGENT_ROLE",
  "SKILL_CONTRACT", "TOOL_CONTRACT", "CAPABILITY_CONTEXT", "REPOSITORY_CONTEXT",
  "WORKFLOW_CONTEXT", "PHASE_CONTEXT", "TASK_CONTEXT", "RUNTIME_EVIDENCE",
  "MEMORY_CONTEXT", "OUTPUT_CONTRACT", "APPROVAL_POLICY", "DATA_ACCESS_POLICY",
];

export default function PromptLayersPage() {
  const [filter, setFilter] = useState<{ scopeType?: string; layerType?: string }>({});
  const params: Record<string, string> = {};
  if (filter.scopeType) params.scopeType = filter.scopeType;
  if (filter.layerType) params.layerType = filter.layerType;
  const { data, isLoading, mutate } = useSWR(["runtime-layers", params], () => runtimeApi.listLayers(params));

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "", layerType: "AGENT_ROLE", scopeType: "AGENT_TEMPLATE",
    scopeId: "", content: "", priority: 100, isRequired: false,
  });
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const body = { ...form, scopeId: form.scopeId || undefined };
      await runtimeApi.createLayer(body as never);
      setShowCreate(false);
      setForm({ name: "", layerType: "AGENT_ROLE", scopeType: "AGENT_TEMPLATE", scopeId: "", content: "", priority: 100, isRequired: false });
      await mutate();
    } finally { setCreating(false); }
  }

  const items = (data ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Prompt Layers</h1>
          <p className="text-slate-500 mt-1">Versioned, hashed instruction blocks.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New Layer</button>
      </div>

      <div className="flex gap-3 mb-4">
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
          value={filter.scopeType ?? ""} onChange={e => setFilter(f => ({ ...f, scopeType: e.target.value || undefined }))}>
          <option value="">all scopes</option>
          {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
          value={filter.layerType ?? ""} onChange={e => setFilter(f => ({ ...f, layerType: e.target.value || undefined }))}>
          <option value="">all types</option>
          {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 mb-6 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" required placeholder="name"
              value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
              value={form.layerType} onChange={e => setForm(f => ({ ...f, layerType: e.target.value }))}>
              {LAYER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
              value={form.scopeType} onChange={e => setForm(f => ({ ...f, scopeType: e.target.value }))}>
              {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="scope id (optional, e.g. agent template id)"
              value={form.scopeId} onChange={e => setForm(f => ({ ...f, scopeId: e.target.value }))} />
            <input type="number" className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="priority"
              value={form.priority} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))} />
          </div>
          <textarea rows={5} required className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
            placeholder="content"
            value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={creating}>{creating ? "Creating…" : "Create"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {items.map(l => (
          <div key={l.id as string} className="card p-5 flex items-start gap-4">
            <div className="p-2.5 bg-indigo-50 rounded-lg shrink-0"><ScrollText size={18} className="text-indigo-600" /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="font-medium text-slate-900">{l.name as string}</span>
                <StatusBadge value={l.status as string} />
                <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">{l.layerType as string}</span>
                <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{l.scopeType as string}</span>
                <span className="text-xs text-slate-500">prio {l.priority as number}</span>
                {!!l.isRequired && <span className="text-xs text-amber-700">required</span>}
              </div>
              <p className="text-xs text-slate-500 line-clamp-3 font-mono">{l.content as string}</p>
              {!!l.contentHash && <div className="text-[10px] text-slate-400 font-mono mt-1">hash: {(l.contentHash as string).slice(7, 23)}…</div>}
            </div>
          </div>
        ))}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <ScrollText size={40} className="mx-auto mb-3 opacity-40" />
            <p>No layers match the filter.</p>
          </div>
        )}
      </div>
    </div>
  );
}
