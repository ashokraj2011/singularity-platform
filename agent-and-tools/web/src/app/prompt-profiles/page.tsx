"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Layers, Plus, ChevronRight } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const SCOPE_TYPES = ["PLATFORM", "AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY", "WORKFLOW", "WORKFLOW_PHASE"];

export default function PromptProfilesPage() {
  const { data, isLoading, mutate } = useSWR("runtime-profiles", () => runtimeApi.listProfiles());
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", ownerScopeType: "AGENT_TEMPLATE" });
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await runtimeApi.createProfile(form as never);
      setShowCreate(false);
      setForm({ name: "", description: "", ownerScopeType: "AGENT_TEMPLATE" });
      await mutate();
    } finally { setCreating(false); }
  }

  const items = (data ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Prompt Profiles</h1>
          <p className="text-slate-500 mt-1">Named collections of layered prompts. Attached to agent templates and bindings.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}><Plus size={16} /> New Profile</button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Owner Scope</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.ownerScopeType} onChange={e => setForm(f => ({ ...f, ownerScopeType: e.target.value }))}>
                {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={creating}>{creating ? "Creating…" : "Create"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {items.map(p => {
          const layerCount = (p.layers as unknown[] | undefined)?.length ?? 0;
          return (
            <Link key={p.id as string} href={`/prompt-profiles/${p.id}`}
              className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
              <div className="p-2.5 bg-indigo-50 rounded-lg"><Layers size={20} className="text-indigo-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{p.name as string}</span>
                  <StatusBadge value={p.status as string} />
                  {!!p.ownerScopeType && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{p.ownerScopeType as string}</span>}
                  <span className="text-xs text-slate-500">{layerCount} layers</span>
                </div>
                {!!p.description && <div className="text-sm text-slate-600 mt-1">{p.description as string}</div>}
              </div>
              <ChevronRight size={16} className="text-slate-400 shrink-0" />
            </Link>
          );
        })}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Layers size={40} className="mx-auto mb-3 opacity-40" />
            <p>No profiles yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
