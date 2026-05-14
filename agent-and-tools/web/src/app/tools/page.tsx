"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { toolApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus, Wrench, Zap, ShieldCheck, ShieldOff, X, Tag } from "lucide-react";

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
  const [wizardStep, setWizardStep] = useState(0);
  // M20 — additional facets and detail-modal state
  const [tagFilter, setTagFilter]       = useState<string>("");          // "" = any
  const [riskFilter, setRiskFilter]     = useState<string>("");          // "" | low | medium | high | critical
  const [targetFilter, setTargetFilter] = useState<string>("");          // "" | LOCAL | SERVER
  const [detail, setDetail]             = useState<Record<string, unknown> | null>(null);
  const [busyKey, setBusyKey]           = useState<string | null>(null); // tool_name@version while toggling approval
  const [form, setForm] = useState({
    tool_name: "", display_name: "", description: "", version: "1.0.0",
    risk_level: "low", requires_approval: false, execution_target: "LOCAL",
    input_schema: SCHEMA_TEMPLATE, output_schema: "", runtime: RUNTIME_TEMPLATE,
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
        output_schema: form.output_schema ? JSON.parse(form.output_schema) as Record<string, unknown> : undefined,
        requires_approval: form.requires_approval,
        execution_target: form.execution_target,
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

  async function handleToggleApproval(name: string, version: string, current: boolean) {
    const key = `${name}@${version}`;
    setBusyKey(key);
    try {
      await toolApi.patch(name, version, { requires_approval: !current });
      await mutate();
    } finally {
      setBusyKey(null);
    }
  }

  // Build the tag union once for the chip strip.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of (data?.tools ?? []) as Array<Record<string, unknown>>) {
      const tags = (t.tags as string[]) ?? [];
      for (const tag of tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [data]);

  const tools = ((data?.tools ?? []) as Array<Record<string, unknown>>).filter((tool) => {
    if (filter !== "all" && tool.status !== filter) return false;
    if (riskFilter && tool.risk_level !== riskFilter) return false;
    if (targetFilter && tool.execution_target !== targetFilter) return false;
    if (tagFilter) {
      const tags = (tool.tags as string[]) ?? [];
      if (!tags.includes(tagFilter)) return false;
    }
    return true;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Tools</h1>
          <p className="text-slate-500 mt-1">Tool registry — register, version, and activate tools</p>
        </div>
        <button className="btn-primary" onClick={() => { setWizardStep(0); setShowCreate(true); }}>
          <Plus size={16} /> Register Tool
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-3">
        {["all", "active", "draft", "suspended"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
              filter === f ? "bg-singularity-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}>
            {f}
          </button>
        ))}
      </div>

      {/* M20 — facets: risk, execution target, tag */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <span className="text-xs text-slate-500 uppercase tracking-wider">Risk:</span>
        {["", "low", "medium", "high", "critical"].map(r => (
          <button key={r || "any"} onClick={() => setRiskFilter(r)}
            className={`text-xs px-2 py-1 rounded ${riskFilter === r ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {r || "any"}
          </button>
        ))}
        <span className="ml-3 text-xs text-slate-500 uppercase tracking-wider">Target:</span>
        {["", "LOCAL", "SERVER"].map(t => (
          <button key={t || "any"} onClick={() => setTargetFilter(t)}
            className={`text-xs px-2 py-1 rounded ${targetFilter === t ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {t || "any"}
          </button>
        ))}
        {allTags.length > 0 && (
          <>
            <span className="ml-3 text-xs text-slate-500 uppercase tracking-wider flex items-center gap-1"><Tag size={11}/> Tag:</span>
            <button onClick={() => setTagFilter("")}
              className={`text-xs px-2 py-1 rounded ${tagFilter === "" ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
              any
            </button>
            {allTags.map(tag => (
              <button key={tag} onClick={() => setTagFilter(tag)}
                className={`text-xs px-2 py-1 rounded ${tagFilter === tag ? "bg-singularity-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
                {tag}
              </button>
            ))}
          </>
        )}
      </div>

      {showCreate && (
        <div className="card p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="font-semibold text-slate-900">Tool Creation Wizard</h2>
              <p className="text-sm text-slate-500 mt-1">Create a governed tool in four steps: identity, contract, execution, and activation rules.</p>
            </div>
            <button type="button" className="btn-secondary text-xs" onClick={() => setShowCreate(false)}>Close</button>
          </div>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {["Identity", "Contract", "Runtime", "Governance"].map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => setWizardStep(index)}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold ${wizardStep === index ? "border-singularity-600 bg-singularity-50 text-singularity-700" : "border-slate-200 bg-white text-slate-500"}`}
              >
                {index + 1}. {label}
              </button>
            ))}
          </div>
          <form onSubmit={handleCreate} className="space-y-4">
            {wizardStep === 0 && (
              <div className="space-y-4">
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
                    placeholder="When should an agent use this tool?"
                    value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tags</label>
                  <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                    placeholder="code, search, github"
                    value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
                </div>
              </div>
            )}

            {wizardStep === 1 && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Input Schema (JSON)</label>
                  <textarea rows={10} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                    value={form.input_schema} onChange={e => setForm(f => ({ ...f, input_schema: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Output Schema (optional JSON)</label>
                  <textarea rows={10} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                    placeholder='{"type":"object","properties":{"result":{"type":"string"}}}'
                    value={form.output_schema} onChange={e => setForm(f => ({ ...f, output_schema: e.target.value }))} />
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {["LOCAL", "SERVER"].map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, execution_target: target }))}
                      className={`rounded-lg border p-4 text-left ${form.execution_target === target ? "border-singularity-600 bg-singularity-50" : "border-slate-200 bg-white"}`}
                    >
                      <div className="font-semibold text-slate-900">{target === "LOCAL" ? "Local MCP tool" : "Server-governed tool"}</div>
                      <div className="text-xs text-slate-500 mt-1">{target === "LOCAL" ? "Runs in the MCP server near the working directory." : "Runs through the central tool-service execution path."}</div>
                    </button>
                  ))}
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Runtime (JSON)</label>
                  <textarea rows={8} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                    value={form.runtime} onChange={e => setForm(f => ({ ...f, runtime: e.target.value }))} />
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Risk Level</label>
                    <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                      value={form.risk_level} onChange={e => setForm(f => ({ ...f, risk_level: e.target.value }))}>
                      {["low", "medium", "high", "critical"].map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 w-full">
                      <input
                        type="checkbox"
                        checked={form.requires_approval}
                        onChange={e => setForm(f => ({ ...f, requires_approval: e.target.checked }))}
                      />
                      Requires human approval
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Allowed Capabilities</label>
                    <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                      placeholder="cap-a, cap-b"
                      value={form.allowed_capabilities} onChange={e => setForm(f => ({ ...f, allowed_capabilities: e.target.value }))} />
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <div className="font-semibold text-slate-800 mb-1">Review</div>
                  <div><span className="font-medium">Tool:</span> {form.tool_name || "unnamed"}@{form.version || "1.0.0"}</div>
                  <div><span className="font-medium">Target:</span> {form.execution_target} · <span className="font-medium">Risk:</span> {form.risk_level} · <span className="font-medium">Approval:</span> {form.requires_approval ? "required" : "not required"}</div>
                </div>
              </div>
            )}
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <div className="flex justify-between gap-3">
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" disabled={wizardStep === 0} onClick={() => setWizardStep(s => Math.max(0, s - 1))}>Back</button>
                <button type="button" className="btn-secondary" disabled={wizardStep === 3} onClick={() => setWizardStep(s => Math.min(3, s + 1))}>Next</button>
              </div>
              <button type="submit" className="btn-primary" disabled={creating || wizardStep !== 3}>
                {creating ? "Registering…" : "Register Tool"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading tools…</div>}

      <div className="space-y-3">
        {tools.map((t) => {
          const runtime = t.runtime as Record<string, unknown> | undefined;
          const tags = (t.tags as string[]) ?? [];
          const requiresApproval = Boolean(t.requires_approval);
          const key = `${t.tool_name as string}@${t.version as string}`;
          return (
            <div key={key}
                 onClick={() => setDetail(t)}
                 className="card p-5 flex items-start gap-4 cursor-pointer hover:border-slate-300 transition-colors">
              <div className="p-2.5 bg-purple-50 rounded-lg shrink-0">
                <Wrench size={20} className="text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{t.display_name as string}</span>
                  <code className="text-xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{t.tool_name as string}@{t.version as string}</code>
                  <StatusBadge value={t.status as string} />
                  <StatusBadge value={t.risk_level as string} />
                  {requiresApproval && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-semibold">
                      <ShieldCheck size={10} /> approval
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-wider bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-mono">
                    {t.execution_target as string}
                  </span>
                </div>
                <p className="text-sm text-slate-600 mb-1">{t.description as string}</p>
                <div className="text-xs text-slate-400 flex flex-wrap items-center gap-2">
                  {!!runtime && <span>{runtime.execution_location as string} · {runtime.runtime_type as string}</span>}
                  {tags.length > 0 && (
                    <span className="flex items-center gap-1">
                      {tags.map(tag => (
                        <span key={tag} className="inline-flex items-center bg-slate-100 px-1.5 py-0.5 rounded">{tag}</span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => handleToggleApproval(t.tool_name as string, t.version as string, requiresApproval)}
                  disabled={busyKey === key}
                  className="btn-secondary text-xs"
                  title={requiresApproval ? "Disable approval gate" : "Require approval before this tool runs"}
                >
                  {requiresApproval ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                  {busyKey === key ? "…" : (requiresApproval ? "Disable approval" : "Require approval")}
                </button>
                {t.status !== "active" && (
                  <button onClick={() => handleActivate(t.tool_name as string, t.version as string)}
                    className="btn-secondary text-xs">
                    <Zap size={14} /> Activate
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!isLoading && tools.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Wrench size={40} className="mx-auto mb-3 opacity-40" />
            <p>No tools match the current filters.</p>
          </div>
        )}
      </div>

      {/* M20 — detail modal */}
      {detail && (
        <div
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-6"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between p-5 border-b border-slate-200">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h2 className="text-lg font-semibold text-slate-900 truncate">{detail.display_name as string}</h2>
                  <code className="text-xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                    {detail.tool_name as string}@{detail.version as string}
                  </code>
                  <StatusBadge value={detail.status as string} />
                  <StatusBadge value={detail.risk_level as string} />
                  {Boolean(detail.requires_approval) && (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-semibold">
                      <ShieldCheck size={10} /> approval
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-600">{detail.description as string}</p>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-700 shrink-0">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-5 text-sm">
              <DetailRow label="Execution target" value={String(detail.execution_target ?? "")} mono />
              {!!detail.runtime && (
                <DetailRow label="Runtime" value={JSON.stringify(detail.runtime, null, 2)} block />
              )}
              <DetailRow label="Input schema" value={JSON.stringify(detail.input_schema, null, 2)} block />
              {detail.output_schema != null && typeof detail.output_schema === "object" && Object.keys(detail.output_schema as Record<string, unknown>).length > 0 ? (
                <DetailRow label="Output schema" value={JSON.stringify(detail.output_schema, null, 2)} block />
              ) : null}
              {Array.isArray(detail.tags) && detail.tags.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {(detail.tags as string[]).map(tag => (
                      <span key={tag} className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono, block }: { label: string; value: string; mono?: boolean; block?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      {block ? (
        <pre className={`bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs overflow-x-auto ${mono ? "font-mono" : ""}`}>{value}</pre>
      ) : (
        <div className={`text-slate-800 ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
      )}
    </div>
  );
}
