"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Plus, Bot, ChevronRight } from "lucide-react";
import { agentApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const fetcher = () => agentApi.list();

export default function AgentsPage() {
  const { data, isLoading, mutate } = useSWR("agents", fetcher);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    capability_id: "", agent_id: "", name: "", description: "",
    agent_type: "llm_agent", owner_team_id: "",
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await agentApi.create({
        ...form,
        owner_team_id: form.owner_team_id || undefined,
      } as Record<string, unknown>);
      setShowCreate(false);
      setForm({ capability_id: "", agent_id: "", name: "", description: "", agent_type: "llm_agent", owner_team_id: "" });
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setCreating(false);
    }
  }

  const agents = data?.agents ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Agents</h1>
          <p className="text-slate-500 mt-1">Capability-scoped agents with versioned prompts and learning profiles</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New Agent
        </button>
      </div>

      {showCreate && (
        <div className="card p-6 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">Create Agent</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Capability ID *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                placeholder="e.g. context-fabric"
                value={form.capability_id} onChange={e => setForm(f => ({ ...f, capability_id: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Agent ID *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                placeholder="e.g. developer-agent"
                value={form.agent_id} onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                placeholder="Display name"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Agent Type</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.agent_type} onChange={e => setForm(f => ({ ...f, agent_type: e.target.value }))}>
                {["llm_agent","workflow_agent","tool_agent","approval_agent","planner_agent",
                  "architect_agent","developer_agent","qa_agent","governance_agent","summarizer_agent"
                ].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="What this agent does"
                value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            {error && <div className="col-span-2 text-red-600 text-sm">{error}</div>}
            <div className="col-span-2 flex gap-3">
              <button type="submit" className="btn-primary" disabled={creating}>
                {creating ? "Creating…" : "Create Agent"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading agents…</div>}

      <div className="space-y-3">
        {agents.map((agent) => {
          const a = agent as Record<string, unknown>;
          return (
            <Link key={a.agent_uid as string} href={`/agents/${a.agent_uid}`}
              className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
              <div className="p-2.5 bg-singularity-50 rounded-lg">
                <Bot size={20} className="text-singularity-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{a.name as string}</span>
                  <StatusBadge value={a.status as string} />
                  <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{a.agent_type as string}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 font-mono">{a.agent_key as string}</div>
                {!!a.description && <div className="text-sm text-slate-600 mt-1 truncate">{a.description as string}</div>}
              </div>
              <ChevronRight size={16} className="text-slate-400 shrink-0" />
            </Link>
          );
        })}
        {!isLoading && agents.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Bot size={40} className="mx-auto mb-3 opacity-40" />
            <p>No agents yet. Create your first agent to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
