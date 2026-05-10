"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { GitBranch, ChevronRight, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default function CapabilitiesPage() {
  const { data, isLoading, mutate } = useSWR("runtime-capabilities", () => runtimeApi.listCapabilities());
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", capabilityType: "APPLICATION", criticality: "MEDIUM", description: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true); setError(null);
    try {
      await runtimeApi.createCapability(form as never);
      setShowCreate(false);
      setForm({ name: "", capabilityType: "APPLICATION", criticality: "MEDIUM", description: "" });
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally { setCreating(false); }
  }

  const items = (data ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Capabilities</h1>
          <p className="text-slate-500 mt-1">Applications and components that agents operate inside.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Capability
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 mb-6 space-y-3">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Core Common Rule Engine" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.capabilityType} onChange={e => setForm(f => ({ ...f, capabilityType: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Criticality</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.criticality} onChange={e => setForm(f => ({ ...f, criticality: e.target.value }))}>
                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={creating}>{creating ? "Creating…" : "Create"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {items.map(c => (
          <Link key={c.id as string} href={`/capabilities/${c.id}`}
            className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
            <div className="p-2.5 bg-purple-50 rounded-lg"><GitBranch size={20} className="text-purple-600" /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900">{c.name as string}</span>
                <StatusBadge value={c.status as string} />
                {!!c.capabilityType && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{c.capabilityType as string}</span>}
                {!!c.criticality && <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">crit: {c.criticality as string}</span>}
              </div>
              {!!c.description && <div className="text-sm text-slate-600 mt-1">{c.description as string}</div>}
            </div>
            <ChevronRight size={16} className="text-slate-400 shrink-0" />
          </Link>
        ))}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <GitBranch size={40} className="mx-auto mb-3 opacity-40" />
            <p>No capabilities yet. Create your first one above.</p>
          </div>
        )}
      </div>
    </div>
  );
}
