"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Activity, Play, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default function RuntimeExecutionsPage() {
  const { data: execs, isLoading, mutate } = useSWR("runtime-executions", () => runtimeApi.listExecutions(), { refreshInterval: 5000 });
  const { data: templates } = useSWR("tmpl-options-exec", () => runtimeApi.listTemplates());
  const { data: capabilities } = useSWR("cap-options-exec", () => runtimeApi.listCapabilities());

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    agentTemplateId: "", agentBindingId: "", capabilityId: "",
    userRequest: "Analyze impact of adding evaluation_group support to CCRE.",
    modelProvider: "stub", modelName: "stub-model",
  });
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const created = await runtimeApi.createExecution({
        agentTemplateId: form.agentTemplateId,
        agentBindingId: form.agentBindingId || undefined,
        capabilityId: form.capabilityId || undefined,
        userRequest: form.userRequest,
        modelProvider: form.modelProvider,
        modelName: form.modelName,
      } as never) as Record<string, unknown>;
      const id = created.id as string;
      // start immediately
      await runtimeApi.startExecution(id, { workflowPhase: "IMPACT_ANALYSIS", task: form.userRequest } as never);
      setShowCreate(false);
      await mutate();
    } finally { setCreating(false); }
  }

  async function handleStart(id: string) {
    await runtimeApi.startExecution(id, { workflowPhase: "IMPACT_ANALYSIS" } as never);
    await mutate();
  }

  const items = (execs ?? []) as Record<string, unknown>[];
  const tmplOptions = (templates?.items ?? []) as Record<string, unknown>[];
  const capOptions = (capabilities ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Runtime Runs</h1>
          <p className="text-slate-500 mt-1">Live agent runs · auto-refreshes every 5s</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New Execution</button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 mb-6 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Agent Template *</label>
              <select required className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.agentTemplateId} onChange={e => setForm(f => ({ ...f, agentTemplateId: e.target.value }))}>
                <option value="">—</option>
                {tmplOptions.map(t => <option key={t.id as string} value={t.id as string}>{t.name as string}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Capability</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.capabilityId} onChange={e => setForm(f => ({ ...f, capabilityId: e.target.value }))}>
                <option value="">—</option>
                {capOptions.map(c => <option key={c.id as string} value={c.id as string}>{c.name as string}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Binding ID (optional)</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="binding uuid"
                value={form.agentBindingId} onChange={e => setForm(f => ({ ...f, agentBindingId: e.target.value }))} />
            </div>
          </div>
          <textarea rows={3} required className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            placeholder="user request"
            value={form.userRequest} onChange={e => setForm(f => ({ ...f, userRequest: e.target.value }))} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={creating}>{creating ? "Starting…" : "Create + Start"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {items.map(e => {
          const at = e.agentTemplate as Record<string, unknown> | undefined;
          const cap = e.capability as Record<string, unknown> | undefined;
          return (
            <div key={e.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-emerald-50 rounded-lg shrink-0">
                <Activity size={18} className="text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{at?.name as string ?? "—"}</span>
                  <StatusBadge value={e.executionStatus as string} />
                  {!!cap && <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{cap.name as string}</span>}
                  <span className="text-xs text-slate-400 font-mono">{e.modelProvider as string}/{e.modelName as string}</span>
                </div>
                <p className="text-sm text-slate-700">{e.userRequest as string}</p>
                <div className="text-xs text-slate-400 mt-1">{new Date(e.createdAt as string).toLocaleString()}</div>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <Link href={`/runtime-executions/${e.id}`} className="btn-secondary text-xs">View receipt</Link>
                {e.executionStatus === "CREATED" && (
                  <button onClick={() => handleStart(e.id as string)} className="btn-primary text-xs"><Play size={12} /> Start</button>
                )}
              </div>
            </div>
          );
        })}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Activity size={40} className="mx-auto mb-3 opacity-40" />
            <p>No executions yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
