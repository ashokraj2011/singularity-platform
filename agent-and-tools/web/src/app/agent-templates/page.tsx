"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Bot, ChevronRight, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const ROLE_TYPES = ["ARCHITECT", "DEVELOPER", "QA", "GOVERNANCE", "BUSINESS_ANALYST", "PRODUCT_OWNER", "DEVOPS", "SECURITY"];

export default function AgentTemplatesPage() {
  const { data, isLoading, mutate } = useSWR("runtime-templates", () => runtimeApi.listTemplates());
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", roleType: "ARCHITECT", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true); setError(null);
    try {
      await runtimeApi.createTemplate(form as never);
      setShowCreate(false);
      setForm({ name: "", roleType: "ARCHITECT", description: "" });
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally { setCreating(false); }
  }

  const items = (data?.items ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Agent Templates</h1>
          <p className="text-slate-500 mt-1">Generic agent roles. Specialize per capability via Bindings.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Template
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Architect Agent" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Role Type</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.roleType} onChange={e => setForm(f => ({ ...f, roleType: e.target.value }))}>
                {ROLE_TYPES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
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
        {items.map(t => (
          <Link key={t.id as string} href={`/agent-templates/${t.id}`}
            className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
            <div className="p-2.5 bg-singularity-50 rounded-lg"><Bot size={20} className="text-singularity-600" /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-900">{t.name as string}</span>
                <StatusBadge value={t.status as string} />
                <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{t.roleType as string}</span>
              </div>
              {!!t.description && <div className="text-sm text-slate-600 mt-1">{t.description as string}</div>}
            </div>
            <ChevronRight size={16} className="text-slate-400 shrink-0" />
          </Link>
        ))}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Bot size={40} className="mx-auto mb-3 opacity-40" />
            <p>No templates yet. Run `prisma db seed` to load defaults.</p>
          </div>
        )}
      </div>
    </div>
  );
}
