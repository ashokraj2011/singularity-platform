"use client";
import { useState } from "react";
import useSWR from "swr";
import { ShieldCheck, Plus } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const SCOPE_TYPES = ["AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY", "ROLE", "WORKFLOW_PHASE", "TEAM", "USER"];

export default function ToolGrantsPage() {
  const { data: tools } = useSWR("runtime-tools", () => runtimeApi.listToolDefs());
  const { data: policies, mutate: mutatePolicies } = useSWR("runtime-policies", () => runtimeApi.listPolicies());
  const { data: grants, mutate: mutateGrants } = useSWR("runtime-grants", () => runtimeApi.listGrants());

  const [policyForm, setPolicyForm] = useState({ name: "", description: "", scopeType: "AGENT_BINDING", scopeId: "" });
  const [grantForm, setGrantForm] = useState({
    toolPolicyId: "", toolId: "",
    grantScopeType: "AGENT_BINDING", grantScopeId: "",
    workflowPhase: "", environment: "DEV",
  });

  const [validateForm, setValidateForm] = useState({
    agentBindingId: "", capabilityId: "", toolName: "repo.search",
    workflowPhase: "IMPACT_ANALYSIS", environment: "DEV",
    input: '{"repositoryId":"ccre-runtime","query":"evaluation_group"}',
  });
  const [validateResult, setValidateResult] = useState<Record<string, unknown> | null>(null);

  async function createPolicy() {
    if (!policyForm.name) return;
    await runtimeApi.createPolicy({ ...policyForm, scopeId: policyForm.scopeId || undefined } as never);
    setPolicyForm({ name: "", description: "", scopeType: "AGENT_BINDING", scopeId: "" });
    await mutatePolicies();
  }
  async function createGrant() {
    if (!grantForm.toolPolicyId || !grantForm.toolId || !grantForm.grantScopeId) return;
    await runtimeApi.createGrant({
      ...grantForm,
      workflowPhase: grantForm.workflowPhase || undefined,
      environment: grantForm.environment || undefined,
    } as never);
    setGrantForm(g => ({ ...g, grantScopeId: "" }));
    await mutateGrants();
  }
  async function validateCall() {
    let parsed: unknown;
    try { parsed = JSON.parse(validateForm.input); } catch { parsed = {}; }
    const body = {
      agentBindingId: validateForm.agentBindingId || undefined,
      capabilityId: validateForm.capabilityId || undefined,
      toolName: validateForm.toolName,
      workflowPhase: validateForm.workflowPhase || undefined,
      environment: validateForm.environment || undefined,
      input: parsed,
    };
    const result = await runtimeApi.validateCall(body as never);
    setValidateResult(result as Record<string, unknown>);
  }

  const toolList = (tools ?? []) as Record<string, unknown>[];
  const policyList = (policies ?? []) as Record<string, unknown>[];
  const grantList = (grants ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Tool Grants</h1>
        <p className="text-slate-500 mt-1">Authorization for who can run which tool, in which context.</p>
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">1. Tool Policies</h2>
      <div className="card p-4 mb-4 grid grid-cols-5 gap-2 items-end">
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          placeholder="policy name" value={policyForm.name} onChange={e => setPolicyForm(f => ({ ...f, name: e.target.value }))} />
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          value={policyForm.scopeType} onChange={e => setPolicyForm(f => ({ ...f, scopeType: e.target.value }))}>
          {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="scope id" value={policyForm.scopeId} onChange={e => setPolicyForm(f => ({ ...f, scopeId: e.target.value }))} />
        <button className="btn-primary" onClick={createPolicy}><Plus size={14} /> Create policy</button>
      </div>
      <div className="space-y-2 mb-8">
        {policyList.map(p => (
          <div key={p.id as string} className="card p-3 text-sm flex items-center gap-3">
            <ShieldCheck size={16} className="text-purple-600" />
            <span className="font-medium">{p.name as string}</span>
            <StatusBadge value={p.status as string} />
            <span className="text-xs text-slate-500">{p.scopeType as string}</span>
            <span className="font-mono text-xs text-slate-400">{p.id as string}</span>
          </div>
        ))}
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">2. Grants</h2>
      <div className="card p-4 mb-4 grid grid-cols-7 gap-2 items-end">
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          value={grantForm.toolPolicyId} onChange={e => setGrantForm(g => ({ ...g, toolPolicyId: e.target.value }))}>
          <option value="">policy…</option>
          {policyList.map(p => <option key={p.id as string} value={p.id as string}>{p.name as string}</option>)}
        </select>
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm col-span-2"
          value={grantForm.toolId} onChange={e => setGrantForm(g => ({ ...g, toolId: e.target.value }))}>
          <option value="">tool…</option>
          {toolList.map(t => <option key={t.id as string} value={t.id as string}>{(t.namespace as string)}.{(t.name as string)}</option>)}
        </select>
        <select className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          value={grantForm.grantScopeType} onChange={e => setGrantForm(g => ({ ...g, grantScopeType: e.target.value }))}>
          {SCOPE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="scope id" value={grantForm.grantScopeId} onChange={e => setGrantForm(g => ({ ...g, grantScopeId: e.target.value }))} />
        <button className="btn-primary" onClick={createGrant}><Plus size={14} /> Grant</button>
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
          return (
            <div key={g.id as string} className="card p-3 text-sm flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xs">{t ? `${t.namespace}.${t.name}` : "—"}</span>
              <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">{g.grantScopeType as string}</span>
              <span className="font-mono text-xs text-slate-500">{g.grantScopeId as string}</span>
              {!!g.workflowPhase && <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">phase: {g.workflowPhase as string}</span>}
              {!!g.environment && <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">env: {g.environment as string}</span>}
              <StatusBadge value={g.status as string} />
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
        <button className="btn-primary col-span-2" onClick={validateCall}>Run validation</button>
      </div>
      {validateResult && (
        <pre className="card p-4 text-xs font-mono whitespace-pre-wrap">
{JSON.stringify(validateResult, null, 2)}
        </pre>
      )}
    </div>
  );
}
