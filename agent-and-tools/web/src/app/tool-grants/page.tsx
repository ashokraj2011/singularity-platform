"use client";
import { useState } from "react";
import useSWR from "swr";
import { Archive, Pencil, ShieldCheck, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { IconTile, MetricStrip, PageHero } from "@/components/ui/primitives";
import { ToolVisualChip, ToolVisualMark } from "@/components/tools/ToolVisualMark";
import { toolGrantVisual, toolVisualFor } from "@/lib/toolVisuals";

const SCOPE_TYPES = ["AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY", "ROLE", "WORKFLOW_PHASE", "TEAM", "USER"];

function parseToolInput(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON";
    throw new Error(`Tool input must be valid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export default function ToolGrantsPage() {
  const { data: tools } = useSWR("runtime-tools", () => runtimeApi.listToolDefs());
  const { data: policies, mutate: mutatePolicies } = useSWR("runtime-policies", () => runtimeApi.listPolicies());
  const { data: grants, mutate: mutateGrants } = useSWR("runtime-grants", () => runtimeApi.listGrants());

  const [policyForm, setPolicyForm] = useState({ name: "", description: "", scopeType: "AGENT_BINDING", scopeId: "" });
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [grantForm, setGrantForm] = useState({
    toolPolicyId: "", toolId: "",
    grantScopeType: "AGENT_BINDING", grantScopeId: "",
    workflowPhase: "", environment: "DEV",
  });
  const [editingGrantId, setEditingGrantId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const [validateForm, setValidateForm] = useState({
    agentBindingId: "", capabilityId: "", toolName: "repo.search",
    workflowPhase: "IMPACT_ANALYSIS", environment: "DEV",
    input: '{"repositoryId":"ccre-runtime","query":"evaluation_group"}',
  });
  const [validateResult, setValidateResult] = useState<Record<string, unknown> | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validateBusy, setValidateBusy] = useState(false);

  async function createPolicy() {
    if (!policyForm.name) return;
    if (editingPolicyId) {
      await runtimeApi.updatePolicy(editingPolicyId, { ...policyForm, scopeId: policyForm.scopeId || undefined } as never);
    } else {
      await runtimeApi.createPolicy({ ...policyForm, scopeId: policyForm.scopeId || undefined } as never);
    }
    setPolicyForm({ name: "", description: "", scopeType: "AGENT_BINDING", scopeId: "" });
    setEditingPolicyId(null);
    await mutatePolicies();
  }
  async function createGrant() {
    if (!grantForm.toolPolicyId || !grantForm.toolId || !grantForm.grantScopeId) return;
    if (editingGrantId) {
      await runtimeApi.updateGrant(editingGrantId, {
        workflowPhase: grantForm.workflowPhase || null,
        environment: grantForm.environment || null,
      } as never);
      setEditingGrantId(null);
      setGrantForm({
        toolPolicyId: "", toolId: "",
        grantScopeType: "AGENT_BINDING", grantScopeId: "",
        workflowPhase: "", environment: "DEV",
      });
    } else {
      await runtimeApi.createGrant({
        ...grantForm,
        workflowPhase: grantForm.workflowPhase || undefined,
        environment: grantForm.environment || undefined,
      } as never);
      setGrantForm(g => ({ ...g, grantScopeId: "" }));
    }
    await mutateGrants();
  }

  function editPolicy(policy: Record<string, unknown>) {
    setEditingPolicyId(String(policy.id ?? ""));
    setPolicyForm({
      name: String(policy.name ?? ""),
      description: String(policy.description ?? ""),
      scopeType: String(policy.scopeType ?? "AGENT_BINDING"),
      scopeId: String(policy.scopeId ?? ""),
    });
  }

  function editGrant(grant: Record<string, unknown>) {
    setEditingGrantId(String(grant.id ?? ""));
    setGrantForm({
      toolPolicyId: String(grant.toolPolicyId ?? ""),
      toolId: String(grant.toolId ?? ""),
      grantScopeType: String(grant.grantScopeType ?? "AGENT_BINDING"),
      grantScopeId: String(grant.grantScopeId ?? ""),
      workflowPhase: String(grant.workflowPhase ?? ""),
      environment: String(grant.environment ?? ""),
    });
  }

  async function policyStatus(id: string, status: "ACTIVE" | "INACTIVE") {
    setActionBusyId(id);
    try {
      await runtimeApi.updatePolicy(id, { status } as never);
      await mutatePolicies();
      await mutateGrants();
    } finally {
      setActionBusyId(null);
    }
  }

  async function archivePolicy(id: string) {
    if (!window.confirm("Archive this tool policy and its active grants?")) return;
    setActionBusyId(id);
    try {
      await runtimeApi.deletePolicy(id);
      await mutatePolicies();
      await mutateGrants();
    } finally {
      setActionBusyId(null);
    }
  }

  async function grantStatus(id: string, status: "ACTIVE" | "INACTIVE") {
    setActionBusyId(id);
    try {
      await runtimeApi.updateGrant(id, { status } as never);
      await mutateGrants();
    } finally {
      setActionBusyId(null);
    }
  }

  async function archiveGrant(id: string) {
    if (!window.confirm("Archive this tool grant? It will no longer authorize tool calls.")) return;
    setActionBusyId(id);
    try {
      await runtimeApi.deleteGrant(id);
      await mutateGrants();
    } finally {
      setActionBusyId(null);
    }
  }
  async function validateCall() {
    setValidateBusy(true);
    setValidateError(null);
    setValidateResult(null);
    try {
      if (!validateForm.toolName.trim()) throw new Error("Tool name is required before validation.");
      const body = {
        agentBindingId: validateForm.agentBindingId || undefined,
        capabilityId: validateForm.capabilityId || undefined,
        toolName: validateForm.toolName.trim(),
        workflowPhase: validateForm.workflowPhase || undefined,
        environment: validateForm.environment || undefined,
        input: parseToolInput(validateForm.input),
      };
      const result = await runtimeApi.validateCall(body as never);
      setValidateResult(result as Record<string, unknown>);
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      setValidateBusy(false);
    }
  }

  const toolList = (tools ?? []) as Record<string, unknown>[];
  const policyList = (policies ?? []) as Record<string, unknown>[];
  const grantList = (grants ?? []) as Record<string, unknown>[];
  const grantVisual = toolGrantVisual();
  const activePolicyCount = policyList.filter(policy => String(policy.status ?? "").toUpperCase() === "ACTIVE").length;
  const activeGrantCount = grantList.filter(grant => String(grant.status ?? "").toUpperCase() === "ACTIVE").length;

  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Tool Authorization"
        title="Tool Grants"
        icon={grantVisual.icon}
        tone={grantVisual.tone}
        description="Control who can run each tool, which capability or workflow phase can use it, and when validation should block a call."
      />

      <MetricStrip
        items={[
          { label: "Runtime tools", value: toolList.length, icon: toolVisualFor({ tool_name: "runtime mcp tool registry" }).icon, state: toolList.length > 0 ? "ready" : "waiting" },
          { label: "Active policies", value: activePolicyCount, icon: ShieldCheck, state: activePolicyCount > 0 ? "ready" : "optional" },
          { label: "Active grants", value: activeGrantCount, icon: grantVisual.icon, state: activeGrantCount > 0 ? "ready" : "optional" },
        ]}
      />

      <h2 className="font-semibold text-slate-800 mb-3">1. Tool Policies</h2>
      <div className="card p-4 mb-4 grid grid-cols-6 gap-2 items-end">
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          placeholder="policy name" value={policyForm.name} onChange={e => setPolicyForm(f => ({ ...f, name: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="description" value={policyForm.description} onChange={e => setPolicyForm(f => ({ ...f, description: e.target.value }))} />
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          value={policyForm.scopeType} onChange={e => setPolicyForm(f => ({ ...f, scopeType: e.target.value }))}>
          {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="scope id" value={policyForm.scopeId} onChange={e => setPolicyForm(f => ({ ...f, scopeId: e.target.value }))} />
        <button className="btn-primary" onClick={createPolicy}>{editingPolicyId ? <Pencil size={14} /> : <Plus size={14} />} {editingPolicyId ? "Save policy" : "Create policy"}</button>
        {editingPolicyId && <button className="btn-secondary" onClick={() => { setEditingPolicyId(null); setPolicyForm({ name: "", description: "", scopeType: "AGENT_BINDING", scopeId: "" }); }}>Cancel edit</button>}
      </div>
      <div className="space-y-2 mb-8">
        {policyList.map(p => (
          <div key={p.id as string} className="card p-3 text-sm flex items-center gap-3 flex-wrap">
            <IconTile icon={ShieldCheck} tone="amber" size="sm" title="Policy" />
            <span className="font-medium">{p.name as string}</span>
            <StatusBadge value={p.status as string} />
            <span className="text-xs text-slate-500">{p.scopeType as string}</span>
            <span className="font-mono text-xs text-slate-400">{p.id as string}</span>
            <span className="ml-auto flex flex-wrap gap-2">
              <button className="btn-secondary text-xs" disabled={actionBusyId === p.id} onClick={() => editPolicy(p)}><Pencil size={12} /> Edit</button>
              {p.status === "ACTIVE" ? (
                <button className="btn-secondary text-xs" disabled={actionBusyId === p.id} onClick={() => void policyStatus(p.id as string, "INACTIVE")}>Suspend</button>
              ) : (
                <button className="btn-secondary text-xs" disabled={actionBusyId === p.id} onClick={() => void policyStatus(p.id as string, "ACTIVE")}>Activate</button>
              )}
              <button className="btn-secondary text-xs text-red-600" disabled={actionBusyId === p.id} onClick={() => void archivePolicy(p.id as string)}><Archive size={12} /> Archive</button>
            </span>
          </div>
        ))}
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">2. Grants</h2>
      <div className="card p-4 mb-4 grid grid-cols-7 gap-2 items-end">
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          disabled={Boolean(editingGrantId)}
          value={grantForm.toolPolicyId} onChange={e => setGrantForm(g => ({ ...g, toolPolicyId: e.target.value }))}>
          <option value="">policy…</option>
          {policyList.map(p => <option key={p.id as string} value={p.id as string}>{p.name as string}</option>)}
        </select>
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          disabled={Boolean(editingGrantId)}
          value={grantForm.toolId} onChange={e => setGrantForm(g => ({ ...g, toolId: e.target.value }))}>
          <option value="">tool…</option>
          {toolList.map(t => <option key={t.id as string} value={t.id as string}>{(t.namespace as string)}.{(t.name as string)}</option>)}
        </select>
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          disabled={Boolean(editingGrantId)}
          value={grantForm.grantScopeType} onChange={e => setGrantForm(g => ({ ...g, grantScopeType: e.target.value }))}>
          {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          disabled={Boolean(editingGrantId)}
          placeholder="scope id" value={grantForm.grantScopeId} onChange={e => setGrantForm(g => ({ ...g, grantScopeId: e.target.value }))} />
        <button className="btn-primary" onClick={createGrant}>{editingGrantId ? <Pencil size={14} /> : <Plus size={14} />} {editingGrantId ? "Save grant" : "Grant"}</button>
        {editingGrantId && <button className="btn-secondary" onClick={() => { setEditingGrantId(null); setGrantForm({ toolPolicyId: "", toolId: "", grantScopeType: "AGENT_BINDING", grantScopeId: "", workflowPhase: "", environment: "DEV" }); }}>Cancel edit</button>}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-1 text-xs text-slate-500 px-3">
        <span>workflow phase + environment (optional, blank = any)</span>
      </div>
      <div className="card p-4 mb-4 grid grid-cols-2 gap-2">
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="workflow phase (e.g. IMPACT_ANALYSIS)"
          value={grantForm.workflowPhase} onChange={e => setGrantForm(g => ({ ...g, workflowPhase: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="environment (DEV, STAGING, PROD)"
          value={grantForm.environment} onChange={e => setGrantForm(g => ({ ...g, environment: e.target.value }))} />
      </div>
      <div className="space-y-2 mb-8">
        {grantList.map(g => {
          const t = g.tool as Record<string, unknown> | undefined;
          const visual = toolVisualFor(t);
          return (
            <div key={g.id as string} className="card p-3 text-sm flex items-center gap-3 flex-wrap">
              <ToolVisualMark visual={visual} size="sm" />
              <span className="font-mono text-xs">{t ? `${t.namespace}.${t.name}` : "—"}</span>
              <ToolVisualChip visual={visual} />
              <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">{g.grantScopeType as string}</span>
              <span className="font-mono text-xs text-slate-500">{g.grantScopeId as string}</span>
              {!!g.workflowPhase && <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">phase: {g.workflowPhase as string}</span>}
              {!!g.environment && <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">env: {g.environment as string}</span>}
              <StatusBadge value={g.status as string} />
              <span className="ml-auto flex flex-wrap gap-2">
                <button className="btn-secondary text-xs" disabled={actionBusyId === g.id} onClick={() => editGrant(g)}><Pencil size={12} /> Edit phase</button>
                {g.status === "ACTIVE" ? (
                  <button className="btn-secondary text-xs" disabled={actionBusyId === g.id} onClick={() => void grantStatus(g.id as string, "INACTIVE")}>Revoke</button>
                ) : (
                  <button className="btn-secondary text-xs" disabled={actionBusyId === g.id} onClick={() => void grantStatus(g.id as string, "ACTIVE")}>Activate</button>
                )}
                <button className="btn-secondary text-xs text-red-600" disabled={actionBusyId === g.id} onClick={() => void archiveGrant(g.id as string)}><Archive size={12} /> Archive</button>
              </span>
            </div>
          );
        })}
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">3. Validate Tool Call</h2>
      <div className="card p-4 mb-4 grid grid-cols-2 gap-2">
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="agent binding id (optional)"
          value={validateForm.agentBindingId} onChange={e => setValidateForm(v => ({ ...v, agentBindingId: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="capability id (optional)"
          value={validateForm.capabilityId} onChange={e => setValidateForm(v => ({ ...v, capabilityId: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="tool name e.g. repo.search"
          value={validateForm.toolName} onChange={e => setValidateForm(v => ({ ...v, toolName: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="workflow phase"
          value={validateForm.workflowPhase} onChange={e => setValidateForm(v => ({ ...v, workflowPhase: e.target.value }))} />
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm" placeholder="environment"
          value={validateForm.environment} onChange={e => setValidateForm(v => ({ ...v, environment: e.target.value }))} />
        <textarea rows={3} className="col-span-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
          placeholder='{"repositoryId":"...","query":"..."}'
          value={validateForm.input} onChange={e => setValidateForm(v => ({ ...v, input: e.target.value }))} />
        {validateError && (
          <div className="col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {validateError}
          </div>
        )}
        <button className="btn-primary col-span-2" onClick={validateCall} disabled={validateBusy}>
          {validateBusy ? "Validating..." : "Run validation"}
        </button>
      </div>
      {validateResult && (
        <pre className="card p-4 text-xs font-mono whitespace-pre-wrap">
{JSON.stringify(validateResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
