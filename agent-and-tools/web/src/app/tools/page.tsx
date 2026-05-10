"use client";
import { useState } from "react";
import useSWR from "swr";
import { toolApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus, Wrench, Zap } from "lucide-react";

const fetcher = () => toolApi.list();

const RUNTIME_TEMPLATE = JSON.stringify({
  execution_location: "server",
  runtime_type: "http",
  endpoint_url: "http://my-service/endpoint",
  method: "POST",
}, null, 2);

const SCHEMA_TEMPLATE = JSON.stringify({
  type: "object",
  properties: {
    query: { type: "string", description: "The query" }
  },
  required: ["query"]
}, null, 2);

export default function ToolsPage() {
  const { data, isLoading, mutate } = useSWR("tools", fetcher);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({
    tool_name: "", display_name: "", description: "", version: "1.0.0",
    risk_level: "low", input_schema: SCHEMA_TEMPLATE, runtime: RUNTIME_TEMPLATE,
    allowed_capabilities: "", allowed_agents: "", tags: "",
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await toolApi.register({
        tool_name: form.tool_name,
        version: form.version,
        display_name: form.display_name,
        description: form.description,
        risk_level: form.risk_level,
        input_schema: JSON.parse(form.input_schema) as Record<string, unknown>,
        runtime: JSON.parse(form.runtime) as Record<string, unknown>,
        allowed_capabilities: form.allowed_capabilities ? form.allowed_capabilities.split(",").map(s => s.trim()) : [],
        allowed_agents: form.allowed_agents ? form.allowed_agents.split(",").map(s => s.trim()) : [],
        tags: form.tags ? form.tags.split(",").map(s => s.trim()) : [],
      });
      setShowCreate(false);
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register tool");
    } finally {
      setCreating(false);
    }
  }

  async function handleActivate(name: string, version: string) {
    await toolApi.activate(name, version);
    await mutate();
  }

  const tools = (data?.tools ?? []).filter((t) => {
    const tool = t as Record<string, unknown>;
    return filter === "all" || tool.status === filter;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Tools</h1>
          <p className="text-slate-500 mt-1">Tool registry — register, version, and activate tools</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Register Tool
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-6">
        {["all", "active", "draft", "suspended"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
              filter === f ? "bg-singularity-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}>
            {f}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="card p-6 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">Register Tool</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tool Name *</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                  placeholder="code.search"
                  value={form.tool_name} onChange={e => setForm(f => ({ ...f, tool_name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Display Name *</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                  placeholder="Code Search"
                  value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Version</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  placeholder="1.0.0"
                  value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Description *</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" required
                placeholder="What this tool does"
                value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Risk Level</label>
                <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={form.risk_level} onChange={e => setForm(f => ({ ...f, risk_level: e.target.value }))}>
                  {["low", "medium", "high", "critical"].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Allowed Capabilities</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  placeholder="cap-a, cap-b (comma sep)"
                  value={form.allowed_capabilities} onChange={e => setForm(f => ({ ...f, allowed_capabilities: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tags</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  placeholder="code, search (comma sep)"
                  value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Input Schema (JSON)</label>
                <textarea rows={6} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                  value={form.input_schema} onChange={e => setForm(f => ({ ...f, input_schema: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Runtime (JSON)</label>
                <textarea rows={6} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                  value={form.runtime} onChange={e => setForm(f => ({ ...f, runtime: e.target.value }))} />
              </div>
            </div>
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <div className="flex gap-3">
              <button type="submit" className="btn-primary" disabled={creating}>
                {creating ? "Registering…" : "Register Tool"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading tools…</div>}

      <div className="space-y-3">
        {tools.map((tool) => {
          const t = tool as Record<string, unknown>;
          const runtime = t.runtime as Record<string, unknown>;
          return (
            <div key={`${t.tool_name as string}-${t.version as string}`} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-purple-50 rounded-lg shrink-0">
                <Wrench size={20} className="text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{t.display_name as string}</span>
                  <code className="text-xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{t.tool_name as string}@{t.version as string}</code>
                  <StatusBadge value={t.status as string} />
                  <StatusBadge value={t.risk_level as string} />
                </div>
                <p className="text-sm text-slate-600 mb-1">{t.description as string}</p>
                {!!runtime && (
                  <div className="text-xs text-slate-400">
                    {runtime.execution_location as string} · {runtime.runtime_type as string}
                  </div>
                )}
              </div>
              {t.status !== "active" && (
                <button onClick={() => handleActivate(t.tool_name as string, t.version as string)}
                  className="btn-secondary text-xs shrink-0">
                  <Zap size={14} /> Activate
                </button>
              )}
            </div>
          );
        })}
        {!isLoading && tools.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Wrench size={40} className="mx-auto mb-3 opacity-40" />
            <p>No tools found. Register your first tool.</p>
          </div>
        )}
      </div>
    </div>
  );
}
