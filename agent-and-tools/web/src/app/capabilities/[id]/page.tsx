"use client";
import { useRef, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { identityApi, runtimeApi, workgraphApi, workgraphRunInsightsUrl, type IamBusinessUnit, type IamTeam } from "@/lib/api";
import { CAPABILITY_ROLE_OPTIONS, capabilityRoleLabel } from "@/lib/capabilityRoles";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Archive, Bot, CheckCircle2, ExternalLink, Pencil, PlayCircle, Plus, RefreshCw, Rocket, Save, Sparkles, Upload, X } from "lucide-react";

type CapabilityEditForm = {
  name: string;
  appId: string;
  capabilityType: string;
  criticality: string;
  ownerTeamId: string;
  businessUnitId: string;
  description: string;
};

export default function CapabilityDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const searchParams = useSearchParams();
  const { data: cap, mutate: mutateCap } = useSWR(`cap-${id}`, () => runtimeApi.getCapability(id));
  const { data: iamTeams = [] } = useSWR<IamTeam[]>("iam-teams", () => identityApi.listTeams());
  const { data: iamBusinessUnits = [] } = useSWR<IamBusinessUnit[]>("iam-business-units", () => identityApi.listBusinessUnits());
  const { data: templates } = useSWR("runtime-tmpl-options", () => runtimeApi.listTemplates());
  const runIdFromQuery = searchParams.get("bootstrapRunId");
  const latestRunId = runIdFromQuery ?? (((cap as Record<string, unknown> | undefined)?.bootstrapRuns as Array<Record<string, unknown>> | undefined)?.[0]?.id as string | undefined);
  const { data: bootstrapRun, mutate: mutateBootstrap } = useSWR(
    latestRunId ? `bootstrap-run-${id}-${latestRunId}` : null,
    () => runtimeApi.getBootstrapRun(id, latestRunId as string),
  );

  const [tab, setTab] = useState<"architecture" | "agents" | "bootstrap" | "bindings" | "repos" | "knowledge" | "code" | "sources" | "tuning">(
    runIdFromQuery ? "bootstrap" : "agents",
  );

  // Forms
  const [repo, setRepo] = useState({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
  const [bind, setBind] = useState({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
  const [know, setKnow] = useState({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CapabilityEditForm>({
    name: "",
    appId: "",
    capabilityType: "",
    criticality: "MEDIUM",
    ownerTeamId: "",
    businessUnitId: "",
    description: "",
  });

  if (!cap) return <div className="text-slate-500">Loading…</div>;
  const c = cap as Record<string, unknown>;
  const repos = (c.repositories as Array<Record<string, unknown>>) ?? [];
  const bindings = (c.bindings as Array<Record<string, unknown>>) ?? [];
  const know_artifacts = (c.knowledgeArtifacts as Array<Record<string, unknown>>) ?? [];
  const isArchived = c.status === "ARCHIVED";
  const defaultRepoUrl = repos.map(repo => capabilityString(repo.repoUrl)).find(Boolean) ?? "";

  async function addRepo() {
    if (!repo.repoName || !repo.repoUrl) return;
    await runtimeApi.attachRepo(id, repo as never);
    setRepo({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
    await mutateCap();
  }

  async function addBinding() {
    if (!bind.agentTemplateId || !bind.bindingName) return;
    const template = ((templates?.items ?? []) as Record<string, unknown>[]).find(t => t.id === bind.agentTemplateId);
    await runtimeApi.bindAgent(id, {
      agentTemplateId: bind.agentTemplateId,
      bindingName: bind.bindingName,
      roleInCapability: bind.roleInCapability || template?.roleType,
    });
    setBind({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
    await mutateCap();
  }

  async function addKnowledge() {
    if (!know.title || !know.content) return;
    await runtimeApi.addKnowledge(id, know as never);
    setKnow({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });
    await mutateCap();
  }

  async function archiveCapability() {
    const confirmed = window.confirm(
      "Archive this capability? This disables its bindings, archives capability-scoped agents, stops source polling, and removes active learning artifacts from runtime retrieval.",
    );
    if (!confirmed) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await runtimeApi.archiveCapability(id);
      await mutateCap();
      await mutateBootstrap();
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setArchiving(false);
    }
  }

  function beginEdit() {
    setEditError(null);
    setEditForm({
      name: capabilityString(c.name),
      appId: capabilityString(c.appId),
      capabilityType: capabilityString(c.capabilityType),
      criticality: capabilityString(c.criticality) || "MEDIUM",
      ownerTeamId: capabilityString(c.ownerTeamId),
      businessUnitId: capabilityString(c.businessUnitId),
      description: capabilityString(c.description),
    });
    setEditing(true);
  }

  async function saveCapabilityDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm.name.trim()) {
      setEditError("Capability name is required.");
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      await runtimeApi.updateCapability(id, {
        name: editForm.name.trim(),
        appId: nullableTrim(editForm.appId),
        capabilityType: nullableTrim(editForm.capabilityType),
        criticality: nullableTrim(editForm.criticality),
        ownerTeamId: nullableTrim(editForm.ownerTeamId),
        businessUnitId: nullableTrim(editForm.businessUnitId),
        description: nullableTrim(editForm.description),
      });
      await mutateCap();
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Capability update failed");
    } finally {
      setSavingEdit(false);
    }
  }

  const tmplOptions = (templates?.items ?? []) as Record<string, unknown>[];
  const selectedTemplate = tmplOptions.find((template) => template.id === bind.agentTemplateId);
  const architectureDiagram = getArchitectureDiagram(c, bootstrapRun as Record<string, unknown> | undefined);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-bold text-slate-900">{c.name as string}</h1>
              <StatusBadge value={c.status as string} />
              {!!c.appId && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">app: {c.appId as string}</span>}
            </div>
            {!!c.description && <p className="text-sm text-slate-600 mt-2">{c.description as string}</p>}
            <div className="font-mono text-xs text-slate-400 mt-2">id: {c.id as string}</div>
          </div>
          {!isArchived && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secondary text-xs" onClick={beginEdit}>
                <Pencil size={14} /> Edit details
              </button>
              <button className="btn-secondary text-xs border-red-200 text-red-700 hover:bg-red-50" disabled={archiving} onClick={archiveCapability}>
                <Archive size={14} /> {archiving ? "Archiving..." : "Archive"}
              </button>
            </div>
          )}
        </div>
        {archiveError && <div className="mt-3 text-sm text-red-600">{archiveError}</div>}
        {editError && <div className="mt-3 text-sm text-red-600">{editError}</div>}
        {isArchived && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            This capability is archived. Bindings and capability-scoped agents are disabled, polling is stopped, and active learning artifacts are removed from runtime retrieval.
          </div>
        )}
      </div>

      {editing && !isArchived && (
        <form onSubmit={saveCapabilityDetails} className="card p-4 mb-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Edit capability details</h2>
              <p className="text-xs text-slate-500">Change the runtime metadata. Agents, sources, and learned knowledge stay unchanged.</p>
            </div>
            <button type="button" className="btn-secondary text-xs" onClick={() => setEditing(false)} disabled={savingEdit}>
              <X size={14} /> Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <CapabilityField label="Name *">
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={editForm.name}
                onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                required
              />
            </CapabilityField>
            <CapabilityField label="Type">
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={editForm.capabilityType}
                onChange={e => setEditForm(f => ({ ...f, capabilityType: e.target.value }))}
                placeholder="APPLICATION"
              />
            </CapabilityField>
            <CapabilityField label="App ID">
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={editForm.appId}
                onChange={e => setEditForm(f => ({ ...f, appId: e.target.value }))}
                maxLength={120}
                placeholder="Optional application / CMDB id"
              />
            </CapabilityField>
            <CapabilityField label="Criticality">
              <select
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={editForm.criticality}
                onChange={e => setEditForm(f => ({ ...f, criticality: e.target.value }))}
              >
                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </CapabilityField>
            <CapabilityField label="Owner team">
              {iamTeams.length > 0 ? (
                <select
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={editForm.ownerTeamId}
                  onChange={e => setEditForm(f => ({ ...f, ownerTeamId: e.target.value }))}
                >
                  <option value="">Select IAM team…</option>
                  {iamTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              ) : (
                <input
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={editForm.ownerTeamId}
                  onChange={e => setEditForm(f => ({ ...f, ownerTeamId: e.target.value }))}
                  placeholder="IAM team id"
                />
              )}
            </CapabilityField>
            <CapabilityField label="Business unit">
              {iamBusinessUnits.length > 0 ? (
                <select
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={editForm.businessUnitId}
                  onChange={e => setEditForm(f => ({ ...f, businessUnitId: e.target.value }))}
                >
                  <option value="">Select IAM business unit…</option>
                  {iamBusinessUnits.map(bu => <option key={bu.id} value={bu.id}>{bu.name}</option>)}
                </select>
              ) : (
                <input
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={editForm.businessUnitId}
                  onChange={e => setEditForm(f => ({ ...f, businessUnitId: e.target.value }))}
                  placeholder="IAM business unit id"
                />
              )}
            </CapabilityField>
            <div className="md:col-span-3">
              <CapabilityField label="Description">
                <textarea
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  value={editForm.description}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What this capability owns and how agents should understand it."
                />
              </CapabilityField>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" className="btn-primary" disabled={savingEdit}>
              <Save size={14} /> {savingEdit ? "Saving..." : "Save capability"}
            </button>
          </div>
        </form>
      )}

      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(["architecture", "agents", "bootstrap", "bindings", "repos", "knowledge", "code", "sources", "tuning"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t ? "border-singularity-600 text-singularity-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}>{t}</button>
        ))}
      </div>

      {!isArchived && (
        <div className="card p-4 mb-6 flex flex-wrap items-center justify-between gap-3 border-red-100 bg-red-50/40">
          <div>
            <p className="text-sm font-semibold text-slate-900">Capability lifecycle</p>
            <p className="text-xs text-slate-600">
              Archive disables its agents and bindings, stops source polling, and removes active learning artifacts from runtime retrieval.
            </p>
          </div>
          <button className="btn-secondary text-xs border-red-200 text-red-700 hover:bg-red-50" disabled={archiving} onClick={archiveCapability}>
            <Archive size={14} /> {archiving ? "Archiving..." : "Archive capability"}
          </button>
        </div>
      )}

      <UltraModePanel capability={c} capabilityId={id} defaultRepoUrl={defaultRepoUrl} disabled={isArchived} />

      {architectureDiagram && tab !== "architecture" && (
        <CapabilityArchitecturePanel diagram={architectureDiagram} />
      )}

      {tab === "architecture" && (
        architectureDiagram ? (
          <div className="space-y-4">
            <CapabilityArchitecturePanel diagram={architectureDiagram} />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SummaryCard
                label="Architecture source"
                value={bootstrapRun ? "Bootstrap packet" : "Live capability metadata"}
                note="Bootstrap diagrams include discovered repo/doc signals. Metadata diagrams are regenerated from current capability state."
              />
              <SummaryCard
                label="View type"
                value={String(architectureDiagram.view ?? architectureDiagram.kind ?? "application").replace(/_/g, " ")}
                note="Collection capabilities use a TOGAF-style layered map; application capabilities use a delivery/runtime map."
              />
              <SummaryCard
                label="Runtime grounding"
                value={`${asObjectArray(c.bindings).length} agents · ${asObjectArray(c.repositories).length} repos`}
                note="Agents, knowledge, repos, and receipts feed the operating model shown above."
              />
            </div>
          </div>
        ) : (
          <div className="card p-6 text-sm text-slate-500">No architecture diagram is available for this capability yet.</div>
        )
      )}

      {tab === "agents" && (
        <AgentRosterTab bindings={bindings} onBindMore={() => setTab("bindings")} />
      )}

      {tab === "bootstrap" && (
        <BootstrapTab
          capabilityId={id}
          capability={c}
          runId={latestRunId}
          run={bootstrapRun as Record<string, unknown> | undefined}
          disabled={isArchived}
          onMutate={async () => {
            await mutateCap();
            await mutateBootstrap();
          }}
        />
      )}

      {tab === "bindings" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Agent Template</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={bind.agentTemplateId} onChange={e => {
                  const template = tmplOptions.find(t => t.id === e.target.value);
                  setBind(b => ({
                    ...b,
                    agentTemplateId: e.target.value,
                    roleInCapability: b.roleInCapability || String(template?.roleType ?? ""),
                  }));
                }}>
                <option value="">—</option>
                {tmplOptions.map(t => <option key={t.id as string} value={t.id as string}>{t.name as string} ({t.roleType as string})</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Binding name</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="CCRE Architect Agent"
                value={bind.bindingName} onChange={e => setBind(b => ({ ...b, bindingName: e.target.value }))} />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Role in capability</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={bind.roleInCapability}
                onChange={e => setBind(b => ({ ...b, roleInCapability: e.target.value }))}>
                <option value="">Use template role{selectedTemplate?.roleType ? ` (${capabilityRoleLabel(selectedTemplate.roleType)})` : ""}</option>
                {CAPABILITY_ROLE_OPTIONS.map(role => (
                  <option key={role.value} value={role.value}>{role.label}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                This is the job the agent performs inside this capability.
              </p>
            </div>
            <button className="btn-primary" disabled={isArchived} onClick={addBinding}><Plus size={14} /> Bind</button>
          </div>

          <div className="space-y-2">
            {bindings.map(b => {
              const at = b.agentTemplate as Record<string, unknown>;
              return (
                <div key={b.id as string} className="card p-4 text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-slate-800">{b.bindingName as string}</span>
                    <StatusBadge value={b.status as string} />
                    <span className="text-xs text-slate-500">{at?.name as string}</span>
                  </div>
                  <div className="font-mono text-xs text-slate-400">id: {b.id as string}</div>
                </div>
              );
            })}
            {bindings.length === 0 && <p className="text-slate-400 text-sm">No bindings yet.</p>}
          </div>
        </div>
      )}

      {tab === "repos" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="repo name" value={repo.repoName} onChange={e => setRepo(r => ({ ...r, repoName: e.target.value }))} />
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="https://github.com/org/repo"
              value={repo.repoUrl} onChange={e => setRepo(r => ({ ...r, repoUrl: e.target.value }))} />
            <button className="btn-primary" disabled={isArchived} onClick={addRepo}><Plus size={14} /> Attach</button>
          </div>
          <div className="space-y-2">
            {repos.map(r => (
              <div key={r.id as string} className="card p-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{r.repoName as string}</span>
                  <span className="text-xs text-slate-500">{r.defaultBranch as string}</span>
                </div>
                <a href={r.repoUrl as string} className="text-xs text-singularity-600 hover:underline" target="_blank" rel="noreferrer">{r.repoUrl as string}</a>
              </div>
            ))}
            {repos.length === 0 && <p className="text-slate-400 text-sm">No repositories attached.</p>}
          </div>
        </div>
      )}

      {tab === "code" && (
        <div>
          <p className="text-sm text-slate-600 mb-3">
            Code context is synced through the approval gate. Public GitHub repos are cloned by the runtime; local repos require a fresh directory selection after the bootstrap packet has approved that source.
          </p>
          {repos.length === 0 && (
            <div className="card p-4 text-sm text-slate-500">
              Attach a repository under the <button className="underline" onClick={() => setTab("repos")}>repos</button> tab first — extracted symbols are scoped to a repository.
            </div>
          )}
          {repos.map(r => (
            <CodeExtractCard
              key={r.id as string}
              capabilityId={id}
              repoId={r.id as string}
              repoName={r.repoName as string}
              repoUrl={r.repoUrl as string}
              repositoryType={r.repositoryType as string | undefined}
              disabled={isArchived}
            />
          ))}
        </div>
      )}

      {tab === "sources" && <SourcesTab capabilityId={id} repos={repos} disabled={isArchived} onMutate={mutateCap} />}

      {tab === "tuning" && <TuningTab capabilityId={id} />}

      {tab === "knowledge" && (
        <div>
          <KnowledgeUploadCard
            capabilityId={id}
            artifactType={know.artifactType}
            onUploaded={async () => { await mutateCap(); }}
          />
          <div className="card p-4 mb-4 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="artifactType (e.g. ARCHITECTURE_SUMMARY)"
                value={know.artifactType} onChange={e => setKnow(k => ({ ...k, artifactType: e.target.value }))} />
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="title"
                value={know.title} onChange={e => setKnow(k => ({ ...k, title: e.target.value }))} />
            </div>
            <textarea rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="content"
              value={know.content} onChange={e => setKnow(k => ({ ...k, content: e.target.value }))} />
            <button className="btn-primary" disabled={isArchived} onClick={addKnowledge}><Plus size={14} /> Add Artifact</button>
          </div>
          <div className="space-y-2">
            {know_artifacts.map(a => (
              <div key={a.id as string} className="card p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{a.artifactType as string}</span>
                  <span className="font-medium text-slate-800 text-sm">{a.title as string}</span>
                </div>
                <p className="text-sm text-slate-600">{a.content as string}</p>
              </div>
            ))}
            {know_artifacts.length === 0 && <p className="text-slate-400 text-sm">No knowledge artifacts.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function CapabilityField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{label}</div>
      <div className="text-lg font-semibold text-slate-900 capitalize">{value}</div>
      <p className="text-xs text-slate-500 mt-2">{note}</p>
    </div>
  );
}

function UltraModePanel({
  capability,
  capabilityId,
  defaultRepoUrl,
  disabled,
}: {
  capability: Record<string, unknown>;
  capabilityId: string;
  defaultRepoUrl: string;
  disabled?: boolean;
}) {
  const capabilityName = capabilityString(capability.name) || "Capability";
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ workflowId: string; runId: string; url: string } | null>(null);
  const [form, setForm] = useState({
    goal: "",
    acceptanceCriteria: "",
    repoUrl: "",
    budgetPreset: "balanced",
    modelAlias: "",
  });

  function openUltraMode() {
    setExpanded(true);
    setError(null);
    setForm(current => ({ ...current, repoUrl: current.repoUrl || defaultRepoUrl }));
  }

  async function launchUltraMode(event: React.FormEvent) {
    event.preventDefault();
    const goal = form.goal.trim();
    const repoUrl = (form.repoUrl || defaultRepoUrl).trim();
    if (!goal) {
      setError("Enter the delivery goal or story for the agent team.");
      return;
    }
    if (!repoUrl) {
      setError("Attach or enter a GitHub repository URL so Ultra Mode has a workspace.");
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const shortGoal = goal.length > 54 ? `${goal.slice(0, 54)}...` : goal;
      const workflow = await workgraphApi.createWorkflowTemplate({
        name: `Ultra: ${capabilityName} - ${shortGoal}`,
        description: goal,
        capabilityId,
        starter: "CAPABILITY_WORKBENCH_BRIDGE",
        metadata: {
          workflowType: "SDLC",
          criticality: normalizeCriticality(capability.criticality),
          executionTarget: "SERVER",
          visibility: "PRIVATE",
          requiresApprovalToRun: false,
          tags: [
            { key: "mode", value: "ultra" },
            { key: "capability", value: capabilityName },
          ],
        },
        budgetPolicy: ultraBudgetPolicy(form.budgetPreset),
      });
      const workflowId = capabilityString(workflow.id);
      if (!workflowId) throw new Error("Ultra Mode created a workflow without an id.");

      const run = await workgraphApi.startWorkflowRun(workflowId, {
        name: `Ultra delivery - ${shortGoal}`,
        vars: {
          story: goal,
          acceptanceCriteria: form.acceptanceCriteria.trim(),
          repoUrl,
        },
        globals: {
          ultraMode: true,
          capabilityId,
          capabilityName,
          budgetPreset: form.budgetPreset,
          modelAlias: form.modelAlias.trim() || undefined,
        },
      });
      const runId = capabilityString(run.id);
      if (!runId) throw new Error("Ultra Mode started a run without an id.");
      const url = workgraphRunInsightsUrl(runId);
      setResult({ workflowId, runId, url });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ultra Mode launch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4 mb-6 border-singularity-100 bg-gradient-to-r from-singularity-50 to-white">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-singularity-600 text-white p-2.5 shadow-sm">
            <Rocket size={19} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-singularity-700 font-semibold">Ultra Mode</div>
            <h2 className="text-base font-semibold text-slate-900">Give the agent team an outcome, not a workflow.</h2>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Singularity creates the governed Workbench workflow, starts the run, tracks budget and receipts, then opens Mission Control while the capability agents produce reviewable consumables.
            </p>
          </div>
        </div>
        <button className="btn-primary" disabled={disabled} onClick={openUltraMode}>
          <PlayCircle size={15} /> New Ultra delivery
        </button>
      </div>

      {expanded && (
        <form onSubmit={launchUltraMode} className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="lg:col-span-2">
              <CapabilityField label="Delivery goal *">
                <textarea
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  placeholder="Example: Change the Todo app color theme to red and produce QA proof."
                  value={form.goal}
                  onChange={event => setForm(current => ({ ...current, goal: event.target.value }))}
                  required
                />
              </CapabilityField>
            </div>
            <CapabilityField label="Acceptance criteria">
              <textarea
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Optional constraints, tests, or definition of done."
                value={form.acceptanceCriteria}
                onChange={event => setForm(current => ({ ...current, acceptanceCriteria: event.target.value }))}
              />
            </CapabilityField>
            <CapabilityField label="Repository / workspace *">
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="https://github.com/org/repo"
                value={form.repoUrl}
                onChange={event => setForm(current => ({ ...current, repoUrl: event.target.value }))}
                required
              />
            </CapabilityField>
            <CapabilityField label="Budget preset">
              <select
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.budgetPreset}
                onChange={event => setForm(current => ({ ...current, budgetPreset: event.target.value }))}
              >
                <option value="balanced">Balanced governed delivery</option>
                <option value="coding">Coding heavy</option>
                <option value="verification">Verification focused</option>
                <option value="summary">Lean summary / handoff</option>
              </select>
            </CapabilityField>
            <CapabilityField label="Model alias">
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Optional. Defaults from MCP catalog / workflow config."
                value={form.modelAlias}
                onChange={event => setForm(current => ({ ...current, modelAlias: event.target.value }))}
              />
            </CapabilityField>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              Internally this still uses Workgraph, Workbench, budgets, approvals, MCP workspace context, and consumable receipts. The workflow design is just generated for you.
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => setExpanded(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={busy || disabled}>
                <Rocket size={14} /> {busy ? "Launching..." : "Launch Ultra Mode"}
              </button>
            </div>
          </div>

          {error && <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {result && (
            <a className="mt-3 inline-flex items-center gap-1 text-sm text-singularity-700 hover:underline" href={result.url}>
              <ExternalLink size={13} /> Open Ultra run {result.runId.slice(0, 8)}
            </a>
          )}
        </form>
      )}
    </section>
  );
}

function ultraBudgetPolicy(preset: string): Record<string, unknown> {
  const base = {
    warnAtPercent: 80,
    enforcementMode: "PAUSE_FOR_APPROVAL",
  };
  const byPreset: Record<string, Record<string, number>> = {
    balanced: { maxInputTokens: 60000, maxOutputTokens: 12000, maxTotalTokens: 72000, maxEstimatedCost: 10 },
    coding: { maxInputTokens: 90000, maxOutputTokens: 16000, maxTotalTokens: 106000, maxEstimatedCost: 18 },
    verification: { maxInputTokens: 50000, maxOutputTokens: 10000, maxTotalTokens: 60000, maxEstimatedCost: 8 },
    summary: { maxInputTokens: 20000, maxOutputTokens: 5000, maxTotalTokens: 25000, maxEstimatedCost: 3 },
  };
  const limits = byPreset[preset] ?? byPreset.balanced;
  return {
    ...base,
    ...limits,
    perNodeTypeDefaults: {
      WORKBENCH_TASK: {
        maxInputTokens: Math.min(limits.maxInputTokens, 50000),
        maxOutputTokens: Math.min(limits.maxOutputTokens, 10000),
      },
      AGENT_TASK: {
        maxInputTokens: Math.min(limits.maxInputTokens, 16000),
        maxOutputTokens: Math.min(limits.maxOutputTokens, 2000),
      },
    },
  };
}

function normalizeCriticality(value: unknown): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const next = String(value ?? "").toUpperCase();
  return next === "CRITICAL" || next === "HIGH" || next === "LOW" ? next : "MEDIUM";
}

function capabilityString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableTrim(value: string): string | null {
  const next = value.trim();
  return next ? next : null;
}

function CapabilityArchitecturePanel({
  diagram, compact = false,
}: {
  diagram: Record<string, unknown>;
  compact?: boolean;
}) {
  const layers = asObjectArray(diagram.layers);
  const togaf = String(diagram.view ?? diagram.kind ?? "").toLowerCase().includes("togaf");
  const title = String(diagram.title ?? (togaf ? "TOGAF capability map" : "Capability architecture"));
  const description = String(diagram.description ?? "");

  return (
    <section className={`card p-4 ${compact ? "" : "mb-6"}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            {togaf ? "Collection architecture" : "Capability architecture"}
          </div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {description && <p className="text-xs text-slate-500 mt-1 max-w-3xl">{description}</p>}
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          {togaf ? "TOGAF view" : "Application view"}
        </span>
      </div>

      {togaf ? (
        <div className="space-y-2">
          {layers.map((layer, index) => (
            <div key={String(layer.key ?? index)} className="grid grid-cols-1 md:grid-cols-[180px_1fr] overflow-hidden rounded-lg border border-slate-200">
              <div className="bg-slate-900 px-3 py-3 text-xs font-semibold text-white">
                {String(layer.label ?? `Layer ${index + 1}`)}
              </div>
              <div className="bg-slate-50 px-3 py-3">
                <div className="flex flex-wrap gap-2">
                  {asStringArray(layer.items).map(item => (
                    <span key={item} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          {layers.map((layer, index) => (
            <div key={String(layer.key ?? index)} className="relative rounded-xl border border-slate-200 bg-slate-50 p-3 min-h-[132px]">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">{String(layer.label ?? `Layer ${index + 1}`)}</div>
              <div className="space-y-1.5">
                {asStringArray(layer.items).slice(0, 5).map(item => (
                  <div key={item} className="rounded-md bg-white border border-slate-200 px-2 py-1 text-xs text-slate-700">
                    {item}
                  </div>
                ))}
              </div>
              {index < layers.length - 1 && (
                <div className="hidden md:block absolute -right-2 top-1/2 h-px w-4 bg-slate-300" />
              )}
            </div>
          ))}
        </div>
      )}

      {typeof diagram.mermaid === "string" && diagram.mermaid.trim() && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-singularity-700">Mermaid source</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
            {diagram.mermaid}
          </pre>
        </details>
      )}
    </section>
  );
}

function AgentRosterTab({
  bindings, onBindMore,
}: {
  bindings: Array<Record<string, unknown>>;
  onBindMore: () => void;
}) {
  const active = bindings.filter(b => String(b.status) === "ACTIVE").length;
  const draft = bindings.filter(b => String(b.status) === "DRAFT").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Capability agents</div>
          <div className="text-2xl font-semibold text-slate-900">{bindings.length}</div>
          <p className="text-xs text-slate-500">Generated and manually bound agents for this capability.</p>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Active</div>
          <div className="text-2xl font-semibold text-emerald-700">{active}</div>
          <p className="text-xs text-slate-500">Available for runtime selection.</p>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Draft</div>
          <div className="text-2xl font-semibold text-amber-700">{draft}</div>
          <p className="text-xs text-slate-500">Created by bootstrap or awaiting review.</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Agent roster</h3>
          <p className="text-xs text-slate-500">Bootstrap agents appear here immediately, even before activation.</p>
        </div>
        <button className="btn-secondary text-xs" onClick={onBindMore}>
          <Plus size={14} /> Bind another agent
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {bindings.map(binding => {
          const template = binding.agentTemplate as Record<string, unknown> | undefined;
          const role = binding.roleInCapability ?? template?.roleType ?? "AGENT";
          const templateStatus = String(template?.status ?? binding.status ?? "DRAFT");
          return (
            <div key={binding.id as string} className="card p-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-singularity-50 text-singularity-700 shrink-0">
                  <Bot size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-900">
                      {(template?.name as string | undefined) ?? (binding.bindingName as string)}
                    </span>
                    <StatusBadge value={templateStatus} />
                    <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                      {capabilityRoleLabel(role)}
                    </span>
                  </div>
                  {!!template?.description && (
                    <p className="text-sm text-slate-600 mt-2 line-clamp-2">{template.description as string}</p>
                  )}
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-500">
                    <div>
                      <span className="uppercase tracking-wide">Binding</span>
                      <div className="font-medium text-slate-700 truncate">{binding.bindingName as string}</div>
                    </div>
                    <div>
                      <span className="uppercase tracking-wide">Binding status</span>
                      <div className="font-medium text-slate-700">{binding.status as string}</div>
                    </div>
                    <div className="sm:col-span-2 font-mono truncate">
                      template: {(template?.id as string | undefined) ?? (binding.agentTemplateId as string)}
                    </div>
                    {template?.baseTemplateId ? (
                      <div className="sm:col-span-2 font-mono truncate">
                        derived from: {template.baseTemplateId as string}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {bindings.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <Bot size={36} className="mx-auto mb-3 opacity-50" />
          <p>No agents are bound to this capability yet.</p>
          <button className="btn-primary mt-4" onClick={onBindMore}>
            <Plus size={14} /> Bind agent
          </button>
        </div>
      )}
    </div>
  );
}

function BootstrapTab({
  capabilityId, capability, runId, run, disabled, onMutate,
}: {
  capabilityId: string;
  capability: Record<string, unknown>;
  runId?: string;
  run?: Record<string, unknown>;
  disabled?: boolean;
  onMutate: () => Promise<unknown> | void;
}) {
  const [decisions, setDecisions] = useState<Record<string, "APPROVE" | "REJECT" | "SKIP">>({});
  const [agentSelection, setAgentSelection] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<Record<string, unknown> | null>(null);

  if (!runId) {
    return (
      <div className="card p-6 text-sm text-slate-500">
        <div className="flex items-center gap-2 text-slate-800 font-medium mb-1">
          <Sparkles size={16} className="text-singularity-600" />
          No bootstrap run yet
        </div>
        Create the next capability through the Bootstrap Wizard to stage generated agents and reviewed learning candidates here.
      </div>
    );
  }

  if (!run) return <div className="text-slate-500 text-sm">Loading bootstrap packet...</div>;

  const activeRunId = runId;
  const candidates = ((run.candidates as Array<Record<string, unknown>>) ?? []);
  const groups = groupCandidates(candidates);
  const generatedAgents = getGeneratedAgents(run, capability);
  const runWarnings = ((run.warnings as string[]) ?? []);
  const runErrors = ((run.errors as string[]) ?? []);
  const operatingModel = getOperatingModel(run);
  const architectureDiagram = getArchitectureDiagram(capability, run);
  const repositories = (((run.capability as Record<string, unknown> | undefined)?.repositories as Array<Record<string, unknown>> | undefined) ??
    ((capability.repositories as Array<Record<string, unknown>>) ?? []));
  const knowledgeSources = (((run.capability as Record<string, unknown> | undefined)?.knowledgeSources as Array<Record<string, unknown>> | undefined) ?? []);

  async function submitReview() {
    setBusy(true); setError(null);
    try {
      const approveGroupKeys: string[] = [];
      const rejectGroupKeys: string[] = [];
      for (const group of groups) {
        if (!group.pending) continue;
        const decision = decisions[group.key] ?? "APPROVE";
        if (decision === "APPROVE") approveGroupKeys.push(group.key);
        if (decision === "REJECT") rejectGroupKeys.push(group.key);
      }
      const activateAgentTemplateIds = generatedAgents
        .filter(agent => (agent.activationRequired || (agentSelection[agent.id] ?? true)) && agent.status !== "ACTIVE")
        .map(agent => agent.id);
      await runtimeApi.reviewBootstrapRun(capabilityId, activeRunId, {
        approveGroupKeys,
        rejectGroupKeys,
        activateAgentTemplateIds,
      });
      await onMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  async function syncApprovedSources() {
    setSyncing(true); setError(null); setSyncResult(null);
    try {
      const repositoryIds = repositories
        .filter(repo => repo.repositoryType !== "LOCAL" && !String(repo.repoUrl ?? "").startsWith("local://"))
        .map(repo => repo.id as string);
      const knowledgeSourceIds = knowledgeSources.map(source => source.id as string);
      const out = await runtimeApi.syncCapability(capabilityId, { repositoryIds, knowledgeSourceIds });
      setSyncResult(out);
      await onMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Bootstrap run</div>
          <div className="flex items-center gap-2">
            <StatusBadge value={run.status as string} />
            <span className="font-mono text-xs text-slate-400">{String(run.id).slice(0, 8)}</span>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Human approval controls which staged repo/doc findings become ACTIVE runtime prompt context.
          </p>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Generated agents</div>
          <div className="text-2xl font-semibold text-slate-900">{generatedAgents.length}</div>
          <p className="text-xs text-slate-500">Predefined capability crew with locked Governance / Verifier / Security gates.</p>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Learning groups</div>
          <div className="text-2xl font-semibold text-slate-900">{groups.length}</div>
          <p className="text-xs text-slate-500">Pending groups are invisible to prompt retrieval until materialized.</p>
        </div>
      </div>

      {(runWarnings.length > 0 || runErrors.length > 0 || error) && (
        <div className="card p-4 space-y-2">
          {error && <div className="text-sm text-red-600">{error}</div>}
          {runErrors.map((item, i) => <div key={`err-${i}`} className="text-sm text-red-600">Error: {item}</div>)}
          {runWarnings.map((item, i) => <div key={`warn-${i}`} className="text-sm text-amber-700">Warning: {item}</div>)}
        </div>
      )}

      {operatingModel && (
        <section className="card p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Capability-to-Agent-Team Factory review</h3>
              <p className="text-xs text-slate-500 mt-1">
                The factory staged draft agents, a starter workflow, artifact contracts, tool suggestions, and approval gates. Nothing becomes active until this packet is reviewed.
              </p>
            </div>
            <span className="rounded-full bg-singularity-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-singularity-700">
              {String(operatingModel.targetWorkflowPattern ?? "governed_delivery").replace(/_/g, " ")}
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Starter workflow</div>
              <p className="text-sm font-medium text-slate-900">{String(operatingModel.starterWorkflow ?? "Review required")}</p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Approval gates</div>
              <div className="flex flex-wrap gap-1.5">
                {asStringArray(operatingModel.approvalGates).map(item => (
                  <span key={item} className="rounded-full bg-white px-2 py-1 text-[11px] text-slate-700 border border-slate-200">{item}</span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Artifact contracts</div>
              <div className="flex flex-wrap gap-1.5">
                {asStringArray(operatingModel.artifactContracts).map(item => (
                  <span key={item} className="rounded-full bg-white px-2 py-1 text-[11px] text-slate-700 border border-slate-200">{item.replace(/_/g, " ")}</span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Suggested tools</div>
              <div className="space-y-1">
                {asObjectArray(operatingModel.suggestedTools).map((tool, index) => (
                  <div key={`${tool.name ?? index}`} className="text-xs text-slate-600">
                    <span className="font-mono text-slate-900">{String(tool.name ?? "tool")}</span> — {String(tool.reason ?? "suggested for governed execution")}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {architectureDiagram && (
        <CapabilityArchitecturePanel diagram={architectureDiagram} compact />
      )}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-900">Draft generated agents</h3>
          <span className="text-xs text-slate-500">Unchecked agents remain draft.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {generatedAgents.map(agent => (
            <label key={agent.id} className="card p-4 flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={agent.activationRequired || (agentSelection[agent.id] ?? true)}
                onChange={e => setAgentSelection(s => ({ ...s, [agent.id]: e.target.checked }))}
                disabled={agent.status === "ACTIVE" || agent.activationRequired}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-900">{agent.name}</span>
                  <StatusBadge value={agent.status} />
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{agent.bindingRole ?? agent.roleType}</span>
                  {agent.locked && <span className="text-[10px] uppercase tracking-wide bg-slate-900 text-white px-2 py-0.5 rounded">Locked</span>}
                  {agent.activationRequired && <span className="text-[10px] uppercase tracking-wide bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">Required</span>}
                  {agent.learnsFromGit && <span className="text-[10px] uppercase tracking-wide bg-purple-50 text-purple-700 px-2 py-0.5 rounded">Git grounded</span>}
                </div>
                {agent.grounding && <p className="text-xs text-slate-500 mt-1">{agent.grounding}</p>}
                <div className="font-mono text-[11px] text-slate-400 mt-1">template: {agent.id}</div>
              </div>
            </label>
          ))}
          {generatedAgents.length === 0 && <p className="text-sm text-slate-400">No generated agents recorded on this run.</p>}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-900">Bootstrap review packet</h3>
          <span className="text-xs text-slate-500">Batch approve/reject by group.</span>
        </div>
        <div className="space-y-3">
          {groups.map(group => (
            <div key={group.key} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900">{group.title}</span>
                    <StatusBadge value={group.statusLabel} />
                    <span className="text-xs text-slate-500">{group.items.length} candidate{group.items.length === 1 ? "" : "s"}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{group.sourceRefs}</p>
                </div>
                {group.pending && (
                  <select
                    className="px-2 py-1.5 text-xs border border-slate-200 rounded-md"
                    value={decisions[group.key] ?? "APPROVE"}
                    onChange={e => setDecisions(d => ({ ...d, [group.key]: e.target.value as "APPROVE" | "REJECT" | "SKIP" }))}
                  >
                    <option value="APPROVE">Approve</option>
                    <option value="REJECT">Reject</option>
                    <option value="SKIP">Decide later</option>
                  </select>
                )}
              </div>
              <div className="mt-3 space-y-2">
                {group.items.map(item => (
                  <details key={item.id as string} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-800">
                      {item.title as string}
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-600 max-h-64 overflow-auto">
                      {String(item.content ?? "").slice(0, 6000)}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 && <p className="text-sm text-slate-400">No learning candidates were discovered from the provided sources.</p>}
        </div>
      </section>

      <div className="card p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">Activate approved learning</p>
          <p className="text-xs text-slate-500">
            Review materializes selected groups as ACTIVE knowledge artifacts and activates selected agents. Manual sync is allowed only after approval.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={syncing || disabled} onClick={syncApprovedSources}>
            <RefreshCw size={14} /> {syncing ? "Syncing..." : "Sync approved sources"}
          </button>
          <button className="btn-primary" disabled={busy || disabled} onClick={submitReview}>
            <CheckCircle2 size={14} /> {busy ? "Saving..." : "Apply review"}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className="card p-4 text-xs text-slate-600">
          <div className="font-semibold text-slate-900 mb-2">Last sync result</div>
          <pre className="whitespace-pre-wrap overflow-auto">{JSON.stringify(syncResult, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function groupCandidates(candidates: Array<Record<string, unknown>>) {
  const byKey = new Map<string, Array<Record<string, unknown>>>();
  for (const item of candidates) {
    const key = String(item.groupKey ?? "other");
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return Array.from(byKey.entries()).map(([key, items]) => {
    const first = items[0] ?? {};
    const pending = items.some(item => item.status === "PENDING");
    const materialized = items.some(item => item.status === "MATERIALIZED");
    const rejected = items.every(item => item.status === "REJECTED");
    return {
      key,
      items,
      pending,
      title: String(first.groupTitle ?? key),
      statusLabel: pending ? "PENDING" : materialized ? "MATERIALIZED" : rejected ? "REJECTED" : String(first.status ?? "REVIEWED"),
      sourceRefs: Array.from(new Set(items.map(item => String(item.sourceRef ?? "")).filter(Boolean))).join(", "),
    };
  });
}

function getOperatingModel(run: Record<string, unknown>): Record<string, unknown> | null {
  const summary = run.sourceSummary as Record<string, unknown> | undefined;
  const model = summary?.operatingModel;
  return model && typeof model === "object" && !Array.isArray(model) ? model as Record<string, unknown> : null;
}

function getArchitectureDiagram(
  capability: Record<string, unknown>,
  run?: Record<string, unknown>,
): Record<string, unknown> | null {
  const operatingModel = run ? getOperatingModel(run) : null;
  const fromBootstrap = operatingModel?.architectureDiagram;
  if (fromBootstrap && typeof fromBootstrap === "object" && !Array.isArray(fromBootstrap)) {
    return fromBootstrap as Record<string, unknown>;
  }

  const name = String(capability.name ?? "Capability");
  const appId = capabilityString(capability.appId);
  const capabilityType = capabilityString(capability.capabilityType);
  const collection = isCollectionCapability(capabilityType);
  const repos = asObjectArray(capability.repositories).map(repo => String(repo.repoName ?? repo.repoUrl ?? "Repository")).slice(0, 4);
  const children = asObjectArray(capability.children).map(child => String(child.name ?? child.id ?? "Child capability")).slice(0, 5);
  const bindings = asObjectArray(capability.bindings)
    .map(binding => {
      const template = binding.agentTemplate as Record<string, unknown> | undefined;
      return String(template?.name ?? binding.bindingName ?? "Capability agent");
    })
    .slice(0, 5);
  const knowledge = asObjectArray(capability.knowledgeArtifacts).length;

  if (collection) {
    return {
      kind: "TOGAF_CAPABILITY_COLLECTION",
      view: "togaf",
      title: `${name} TOGAF capability map`,
      description: "Collection capabilities use a layered TOGAF-style view so child applications, data, technology, and governance are visible together.",
      layers: [
        { key: "business", label: "Business Architecture", items: [`${name}${appId ? ` (${appId})` : ""}`, "Outcomes, policies, owners"] },
        { key: "application", label: "Application Architecture", items: children.length ? children : ["Child capabilities / applications"] },
        { key: "data", label: "Data Architecture", items: [`${knowledge} approved knowledge artifacts`, "Shared memory, citations, evidence"] },
        { key: "technology", label: "Technology Architecture", items: repos.length ? repos : ["MCP workspaces, Context Fabric, Workgraph"] },
        { key: "governance", label: "Governance", items: ["Approvals", "Budgets", "Audit receipts", "Locked verifier/governance gates"] },
      ],
      mermaid: [
        "flowchart TB",
        `  B[Business Architecture<br/>${name}]`,
        "  A[Application Architecture<br/>Child capabilities]",
        "  D[Data Architecture<br/>Knowledge and evidence]",
        "  T[Technology Architecture<br/>MCP and workflow runtime]",
        "  G[Governance<br/>Approvals, budgets, audit]",
        "  B --> A --> D --> T --> G",
      ].join("\n"),
    };
  }

  return {
    kind: "APPLICATION_CAPABILITY_ARCHITECTURE",
    view: "application",
    title: `${name} application capability architecture`,
    description: "This generated view links workflow stories, capability agents, grounding sources, execution runtime, and produced evidence.",
    layers: [
      { key: "entry", label: "Entry Points", items: ["Workflow stories", "Workbench stages", "Human approvals"] },
      { key: "agents", label: "Capability Agent Team", items: bindings.length ? bindings : ["Draft agent team pending activation"] },
      { key: "knowledge", label: "Grounding Sources", items: [...(repos.length ? repos : ["Repository pending"]), `${knowledge} knowledge artifacts`] },
      { key: "execution", label: "Execution Runtime", items: ["Prompt Composer", "Context Fabric", "MCP model/tools/AST"] },
      { key: "evidence", label: "Evidence Outputs", items: ["Stage artifacts", "Citations", "Budget receipts", "Audit trail"] },
    ],
    mermaid: [
      "flowchart LR",
      "  S[Story / Workflow Input]",
      `  C[Capability<br/>${name}${appId ? `<br/>App ID: ${appId}` : ""}]`,
      "  A[Agent Team]",
      "  K[Grounding Sources]",
      "  X[Context Fabric + MCP]",
      "  E[Artifacts / Receipts]",
      "  S --> C --> A",
      "  K --> A",
      "  A --> X --> E",
    ].join("\n"),
  };
}

function isCollectionCapability(value: string): boolean {
  return ["COLLECTION", "CAPABILITY_COLLECTION", "PORTFOLIO", "DOMAIN_COLLECTION"].includes(value.trim().toUpperCase());
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>
    : [];
}

function getGeneratedAgents(run: Record<string, unknown>, capability: Record<string, unknown>) {
  const jsonAgents = Array.isArray(run.generatedAgentIds) ? run.generatedAgentIds as Array<Record<string, unknown>> : [];
  const bindings = ((((run.capability as Record<string, unknown> | undefined)?.bindings as Array<Record<string, unknown>> | undefined) ??
    ((capability.bindings as Array<Record<string, unknown>>) ?? [])));
  const byTemplate = new Map<string, Record<string, unknown>>();
  for (const binding of bindings) {
    const template = binding.agentTemplate as Record<string, unknown> | undefined;
    if (template?.id) byTemplate.set(template.id as string, template);
  }
  return jsonAgents.map(agent => {
    const id = agent.id as string;
    const template = byTemplate.get(id);
    return {
      id,
      name: String(template?.name ?? agent.name ?? id),
      roleType: String(template?.roleType ?? agent.roleType ?? "AGENT"),
      bindingRole: String(agent.bindingRole ?? agent.roleType ?? template?.roleType ?? "AGENT"),
      status: String(template?.status ?? "DRAFT"),
      locked: Boolean(template?.lockedReason ?? agent.locked),
      activationRequired: Boolean(agent.activationRequired),
      learnsFromGit: Boolean(agent.learnsFromGit),
      grounding: typeof agent.grounding === "string" ? agent.grounding : "",
    };
  });
}

// M14 — file-upload variant for knowledge artifacts. v0 reads txt/md
// M15 — multipart upload to the agent-runtime endpoint. Server extracts
// text from txt/md directly and from PDFs via pdf-parse, then delegates to
// addKnowledge for embedding + storage.
const SUPPORTED_EXT = /\.(txt|md|markdown|pdf)$/i;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB matches the multer limit

function KnowledgeUploadCard({
  capabilityId, artifactType, onUploaded,
}: {
  capabilityId: string;
  artifactType: string;
  onUploaded: () => Promise<void> | void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList | File[]) {
    setBusy(true); setError(null);
    const arr = Array.from(files);
    try {
      for (const f of arr) {
        if (!SUPPORTED_EXT.test(f.name)) {
          throw new Error(`Unsupported file type: ${f.name}. Accepts .txt, .md, .pdf.`);
        }
        if (f.size > MAX_BYTES) {
          throw new Error(`File too large: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB > 25 MB).`);
        }
      }
      const fd = new FormData();
      fd.append("artifactType", artifactType || "DOC");
      for (const f of arr) fd.append("files", f, f.name);

      const res = await fetch(
        `/api/runtime/capabilities/${encodeURIComponent(capabilityId)}/knowledge-artifacts/upload`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      const body = await res.json() as { data?: { uploaded: number; skipped?: Array<{name:string; reason:string}> } };
      const skipped = body.data?.skipped ?? [];
      if (skipped.length > 0) {
        setError(`Skipped ${skipped.length}: ${skipped.map(s => `${s.name} (${s.reason})`).join(", ")}`);
      }
      setLastUpload(arr.map(f => f.name).filter(n => !skipped.some(s => s.name === n)));
      await onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      className={`card p-4 mb-3 border-2 border-dashed transition-colors ${dragOver ? "border-singularity-500 bg-singularity-50" : "border-slate-200"}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false);
        if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-3">
        <Upload size={18} className="text-slate-500 shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-slate-700 font-medium">Upload knowledge files</p>
          <p className="text-xs text-slate-500">
            Drag and drop <code>.txt</code> / <code>.md</code> / <code>.pdf</code> files, or click to browse. Files become ACTIVE artifacts the prompt-composer pulls into <code>RUNTIME_EVIDENCE</code> layers (and now embedded for semantic retrieval).
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
          className="hidden"
          onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); }}
        />
        <button
          className="btn-primary text-xs whitespace-nowrap"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose files"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      {lastUpload.length > 0 && !error && (
        <div className="mt-2 text-xs text-emerald-700">Uploaded: {lastUpload.join(", ")}</div>
      )}
    </div>
  );
}

// M14 — directory picker → regex symbol extractor → embeddings → DB. Filter
// to source files client-side so we don't ship binaries / images / lockfiles
// over the wire. v0 caps at 25 MB total per request (matches the server's
// express.json limit).
const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/i;
const CODE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);
const FILE_SIZE_CAP = 200_000; // 200 KB per file
const PAYLOAD_CAP   = 24_000_000; // 24 MB total

function CodeExtractCard({
  capabilityId, repoId, repoName, repoUrl, repositoryType, disabled,
}: {
  capabilityId: string;
  repoId: string;
  repoName: string;
  repoUrl: string;
  repositoryType?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<{
    filesProcessed: number; symbolsScanned: number; inserted: number;
    skippedDuplicate: number; embeddingErrors: number;
    provider: string; providerModel: string;
  } | null>(null);
  const isLocal = repositoryType === "LOCAL" || repoUrl.startsWith("local://");

  async function syncRemoteRepo() {
    setBusy(true); setError(null); setResult(null); setSyncSummary(null);
    try {
      const out = await runtimeApi.syncCapability(capabilityId, { repositoryIds: [repoId] });
      setSyncSummary(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleFiles(files: FileList) {
    setBusy(true); setError(null); setResult(null); setSyncSummary(null);
    try {
      const payload: Array<{ path: string; content: string }> = [];
      let bytes = 0;
      for (const f of Array.from(files)) {
        const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (!SOURCE_EXT.test(path)) continue;
        if (path.split("/").some((seg) => CODE_SKIP_DIRS.has(seg))) continue;
        if (f.size > FILE_SIZE_CAP) continue;
        const text = await f.text();
        bytes += text.length;
        if (bytes > PAYLOAD_CAP) {
          throw new Error(
            `Selection exceeds ${PAYLOAD_CAP / 1_000_000} MB after filtering. Trim the directory or extract in batches.`,
          );
        }
        payload.push({ path, content: text });
      }
      if (payload.length === 0) {
        throw new Error("No source files (.py / .ts / .tsx / .js / .jsx) found in selection.");
      }
      const out = await runtimeApi.syncCapability(capabilityId, { localFiles: payload });
      setSyncSummary(out);
      const local = out.local as typeof result | null | undefined;
      if (local) setResult(local);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{repoName}</p>
          <p className="text-xs text-slate-500">
            Code context is synced only after approved bootstrap learning exists. Public repos sync from Git; local sources require a fresh directory selection.
          </p>
        </div>
        {isLocal ? (
          <>
            <input
              ref={inputRef}
              type="file"
              /* webkitdirectory is non-standard but supported by all major browsers */
              // @ts-ignore - non-standard attr
              webkitdirectory=""
              // @ts-ignore - non-standard attr
              directory=""
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); }}
            />
            <button
              className="btn-primary text-xs whitespace-nowrap"
              disabled={busy || disabled}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? "Syncing..." : "Pick approved directory"}
            </button>
          </>
        ) : (
          <button
            className="btn-primary text-xs whitespace-nowrap"
            disabled={busy || disabled}
            onClick={syncRemoteRepo}
          >
            {busy ? "Syncing..." : "Sync GitHub now"}
          </button>
        )}
      </div>
      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}
      {syncSummary && Array.isArray(syncSummary.warnings) && syncSummary.warnings.length > 0 && (
        <div className="mt-3 text-xs text-amber-700">
          {(syncSummary.warnings as string[]).join(" ")}
        </div>
      )}
      {result && (
        <div className="mt-3 text-xs text-slate-700 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Files processed" value={result.filesProcessed} />
          <Stat label="Symbols scanned" value={result.symbolsScanned} />
          <Stat label="Inserted" value={result.inserted} highlight="emerald" />
          <Stat label="Skipped (dup)" value={result.skippedDuplicate} />
          <Stat label="Embedding errors" value={result.embeddingErrors} highlight={result.embeddingErrors > 0 ? "red" : undefined} />
          <Stat label="Provider" value={`${result.provider}:${result.providerModel}`} colSpan={3} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight, colSpan }: { label: string; value: string | number; highlight?: "emerald" | "red"; colSpan?: number }) {
  const colour =
    highlight === "emerald" ? "text-emerald-700" :
    highlight === "red"     ? "text-red-700" :
                              "text-slate-700";
  return (
    <div className={`bg-slate-50 rounded px-2 py-1.5${colSpan ? ` sm:col-span-${colSpan}` : ""}`}>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-medium ${colour} truncate`}>{value}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// M17 — sources tab. Per-repo poll-interval editor + URL knowledge sources
// (markdown / plain text). Worker re-fetches on cadence; only writes when
// content hash changes.
// ────────────────────────────────────────────────────────────────────────────

function SourcesTab({ capabilityId, repos, disabled, onMutate }: {
  capabilityId: string;
  repos: Array<Record<string, unknown>>;
  disabled?: boolean;
  onMutate: () => Promise<unknown> | void;
}) {
  const { data: sources, mutate: mutateSources } = useSWR(
    `know-sources-${capabilityId}`,
    () => runtimeApi.listKnowledgeSources(capabilityId),
  );
  const list = (sources ?? []) as Array<Record<string, unknown>>;

  const [newUrl, setNewUrl] = useState("");
  const [newInterval, setNewInterval] = useState(600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addSource() {
    if (!newUrl) return;
    setBusy(true); setError(null);
    try {
      await runtimeApi.addKnowledgeSource(capabilityId, {
        url: newUrl, pollIntervalSec: newInterval,
      });
      setNewUrl(""); setNewInterval(600);
      await mutateSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally { setBusy(false); }
  }

  async function deleteSource(id: string) {
    await runtimeApi.deleteKnowledgeSource(capabilityId, id);
    await mutateSources();
  }

  return (
    <div className="space-y-6">
      {/* ── Repo polling section ───────────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Repository polling</h3>
        <p className="text-xs text-slate-500 mb-3">
          Set <code>pollIntervalSec</code> on a repo and the agent-runtime worker re-clones + re-extracts symbols when the remote SHA changes. Leave blank to disable.
        </p>
        {repos.length === 0 && <p className="text-sm text-slate-400">No repositories attached. Add one under the <strong>repos</strong> tab.</p>}
        <div className="space-y-2">
          {repos.map(r => <RepoPollRow key={r.id as string} capabilityId={capabilityId} repo={r} disabled={disabled} onMutate={onMutate} />)}
        </div>
      </section>

      {/* ── Knowledge URL sources section ──────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Knowledge URL sources</h3>
        <p className="text-xs text-slate-500 mb-3">
          Worker fetches each URL on cadence; when the content hash changes it archives the prior artifact and creates a new one (also embedded for semantic retrieval).
        </p>

        <div className="card p-3 mb-3 flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">URL</label>
            <input
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              placeholder="https://raw.githubusercontent.com/.../README.md"
              value={newUrl} onChange={e => setNewUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Poll seconds</label>
            <input
              type="number" min={60} max={86400}
              className="w-24 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
              value={newInterval} onChange={e => setNewInterval(Number(e.target.value))}
            />
          </div>
          <button className="btn-primary text-xs" disabled={busy || disabled || !newUrl} onClick={addSource}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

        <div className="space-y-2">
          {list.map(s => (
            <div key={s.id as string} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 truncate">{(s.title as string) || (s.url as string)}</div>
                  <div className="text-xs text-slate-500 truncate">{s.url as string}</div>
                  <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-3">
                    <span>poll: every <strong>{s.pollIntervalSec as number}s</strong></span>
                    <span>last: {s.lastPolledAt ? new Date(s.lastPolledAt as string).toLocaleString() : "never"}</span>
                    {s.lastPollError ? <span className="text-red-600">err: {String(s.lastPollError).slice(0,80)}</span> : null}
                  </div>
                </div>
                <button className="text-xs text-red-600 hover:underline disabled:text-slate-400" disabled={disabled} onClick={() => deleteSource(s.id as string)}>Remove</button>
              </div>
            </div>
          ))}
          {list.length === 0 && <p className="text-sm text-slate-400">No knowledge sources yet.</p>}
        </div>
      </section>
    </div>
  );
}

function RepoPollRow({ capabilityId, repo, disabled, onMutate }: {
  capabilityId: string;
  repo: Record<string, unknown>;
  disabled?: boolean;
  onMutate: () => Promise<unknown> | void;
}) {
  const [interval, setInterval] = useState<string>(repo.pollIntervalSec ? String(repo.pollIntervalSec) : "");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setBusy(true);
    try {
      await runtimeApi.updateRepoPoll(capabilityId, repo.id as string, {
        pollIntervalSec: interval ? Number(interval) : null,
      });
      setSavedAt(Date.now());
      await onMutate();
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800 truncate">{repo.repoName as string}</div>
        <div className="text-xs text-slate-500 truncate">{repo.repoUrl as string}</div>
        <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-3">
          <span>last: {repo.lastPolledAt ? new Date(repo.lastPolledAt as string).toLocaleString() : "never"}</span>
          {repo.lastPolledSha ? <span>sha: <code>{String(repo.lastPolledSha).slice(0,7)}</code></span> : null}
          {repo.lastPollError ? <span className="text-red-600">err: {String(repo.lastPollError).slice(0,80)}</span> : null}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Poll seconds</label>
          <input
            type="number" min={60} max={86400}
            className="w-24 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
            value={interval} onChange={e => setInterval(e.target.value)} placeholder="(off)"
          />
        </div>
        <button className="btn-primary text-xs whitespace-nowrap" disabled={busy || disabled} onClick={save}>
          {busy ? "Saving…" : savedAt && Date.now() - savedAt < 2000 ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// M17 — tuning tab. Calls composer's debug-retrieval endpoint with a sample
// task and shows scored hits per kind so the operator can sanity-check
// which knowledge / memory / code symbols a real compose would surface.
// ────────────────────────────────────────────────────────────────────────────

// Proxied via next.config: /api/composer/* → composer's /api/v1/*
const COMPOSER_DEBUG_URL = "/api/composer/compose-and-respond/debug-retrieval";

interface DebugHit {
  cosineSimilarity: number;
  ageDays: number;
  finalScore: number;
}
interface DebugResponse {
  capabilityId: string;
  task: string;
  provider: string;
  model: string;
  dim: number;
  tuning: { recencyBoostMax: number; recencyBoostDays: number };
  knowledge: Array<DebugHit & { id: string; artifactType: string; title: string; content: string }>;
  memory:    Array<DebugHit & { id: string; memoryType: string; title: string; content: string }>;
  code:      Array<DebugHit & { symbol_id: string; symbolName: string | null; symbolType: string | null;
                                filePath: string; startLine: number | null; summary: string | null;
                                language: string | null; repoName: string }>;
}

function TuningTab({ capabilityId }: { capabilityId: string }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!task.trim()) return;
    setBusy(true); setError(null); setData(null);
    try {
      const res = await fetch(COMPOSER_DEBUG_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId, task }),
      });
      if (!res.ok) throw new Error(`debug ${res.status}: ${(await res.text()).slice(0, 200)}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Retrieval tuning</h3>
        <p className="text-xs text-slate-500">
          Enter a sample task; we'll embed it and run the same hybrid retrieval (cosine × recency boost) the prompt-composer uses, then show scored hits per kind.
          Recency boost is configured via <code>EMBEDDING_RECENCY_BOOST</code> / <code>EMBEDDING_RECENCY_DAYS</code> on the composer container.
        </p>
      </div>
      <div className="card p-3 flex gap-2">
        <input
          className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded-md"
          placeholder="How do I price a bond?"
          value={task} onChange={e => setTask(e.target.value)}
        />
        <button className="btn-primary text-xs" disabled={busy || !task.trim()} onClick={run}>
          {busy ? "Scoring…" : "Run"}
        </button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
      {data && (
        <div className="space-y-3">
          <div className="text-xs text-slate-500">
            provider: <strong>{data.provider}</strong> · model: <strong>{data.model}</strong> · dim: <strong>{data.dim}</strong>
            {" "}· recency boost ≤ <strong>{(data.tuning.recencyBoostMax * 100).toFixed(0)}%</strong> for items &lt; <strong>{data.tuning.recencyBoostDays}d</strong> old
          </div>
          <ScoredSection title="Knowledge" hits={data.knowledge.map(h => ({ ...h, label: h.title, sub: h.artifactType }))} />
          <ScoredSection title="Memory"    hits={data.memory.map(h => ({ ...h, label: h.title, sub: h.memoryType }))} />
          <ScoredSection title="Code"      hits={data.code.map(h => ({
            ...h,
            label: `${h.symbolName ?? "?"} (${h.symbolType ?? "?"})`,
            sub:   `${h.repoName}/${h.filePath}:${h.startLine ?? "?"}`,
          }))} />
        </div>
      )}
    </div>
  );
}

function ScoredSection({ title, hits }: {
  title: string;
  hits: Array<{ label: string; sub: string; cosineSimilarity: number; ageDays: number; finalScore: number }>;
}) {
  return (
    <div className="card p-3">
      <h4 className="text-xs font-semibold text-slate-700 mb-2">{title} ({hits.length})</h4>
      {hits.length === 0 ? (
        <p className="text-xs text-slate-400">No hits.</p>
      ) : (
        <div className="space-y-1.5">
          {hits.map((h, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-slate-400 w-6 shrink-0">#{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 truncate">{h.label}</div>
                <div className="text-slate-500 truncate">{h.sub}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-slate-700">cos <strong>{h.cosineSimilarity.toFixed(3)}</strong></div>
                <div className="text-slate-500">age {h.ageDays.toFixed(1)}d → score <strong>{h.finalScore.toFixed(3)}</strong></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
