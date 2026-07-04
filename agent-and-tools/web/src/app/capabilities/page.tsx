"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  FileText,
  GitBranch,
  Layers3,
  Lock,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import { identityApi, runtimeApi, type IamBusinessUnit, type IamTeam } from "@/lib/api";
import { CAPABILITY_ROLE_OPTIONS } from "@/lib/capabilityRoles";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader, EmptyState, ErrorState } from "@/components/ui/primitives";
import {
  capabilityDisplayName,
  capabilityIdentityKey,
  capabilityIdentityLabel,
  capabilityRowId,
  capabilityRowsFromListResponse,
  capabilityShortId,
  capabilityText,
  duplicateCapabilitiesByIdentity,
  isArchivedCapability,
  uniqueCapabilitiesByIdentity,
} from "./capability-list-model";

type LocalBootstrapFile = { path: string; content: string };
type BootstrapCatalogAgent = {
  key: string;
  roleType: string;
  bindingRole?: string;
  label: string;
  locked?: boolean;
  activationRequired?: boolean;
  learnsFromGit?: boolean;
  grounding?: string;
  description?: string;
};
type BootstrapAgentCatalog = {
  presets?: Array<{ key: string; label: string; agents: string[] }>;
  agents?: BootstrapCatalogAgent[];
};

// M61 Slice D — Operator-confirmed test/build commands captured in
// the new wizard step. Same shape the agent-runtime bootstrap schema
// accepts (capability.schemas.ts:testCommands/buildCommands).
type WizardCommand = {
  kind: string;
  cmd: string;
  cwd?: string;
  expectedDurationSec?: number;
  requiresNetwork?: boolean;
};

type BootstrapForm = {
  name: string;
  appId: string;
  capabilityType: string;
  criticality: string;
  description: string;
  businessUnitId: string;
  ownerTeamId: string;
  githubUrl: string;
  githubBranch: string;
  documentLinks: string;
  targetWorkflowPattern: string;
  agentPreset: string;
  parentCapabilityId: string;
  childCapabilityIds: string[];
  sharedApplications: string;
  // M61 Slice D
  testCommands: WizardCommand[];
  buildCommands: WizardCommand[];
};

const DEFAULT_FORM: BootstrapForm = {
  name: "",
  appId: "",
  capabilityType: "DELIVERY",
  criticality: "MEDIUM",
  description: "",
  businessUnitId: "",
  ownerTeamId: "",
  githubUrl: "",
  githubBranch: "main",
  documentLinks: "",
  targetWorkflowPattern: "governed_delivery",
  agentPreset: "governed_delivery",
  parentCapabilityId: "",
  childCapabilityIds: [],
  sharedApplications: "",
  // M61 Slice D — start empty; operator fills in the wizard step.
  testCommands: [],
  buildCommands: [],
};

const BOOTSTRAP_AGENT_PREVIEW = [
  { key: "product_owner", role: "PRODUCT_OWNER", label: "Product Owner", locked: false, required: false, git: true },
  { key: "business_analyst", role: "BUSINESS_ANALYST", label: "Business Analyst", locked: false, required: false, git: true },
  { key: "architect", role: "ARCHITECT", label: "Architect", locked: false, required: false, git: true },
  { key: "developer", role: "DEVELOPER", label: "Developer", locked: false, required: false, git: true },
  { key: "verifier", role: "QA", label: "Verifier", locked: true, required: true, git: true },
  { key: "qa", role: "QA", label: "QA", locked: false, required: false, git: true },
  { key: "security", role: "SECURITY", label: "Security", locked: true, required: true, git: true },
  { key: "devops", role: "DEVOPS", label: "DevOps", locked: false, required: false, git: true },
  { key: "governance", role: "GOVERNANCE", label: "Governance", locked: true, required: true, git: false },
] as const;

function agentPreviewForPreset(preset: string, catalog?: BootstrapAgentCatalog): BootstrapCatalogAgent[] {
  const backendAgents = Array.isArray(catalog?.agents) && catalog.agents.length > 0
    ? catalog.agents
    : BOOTSTRAP_AGENT_PREVIEW.map(agent => ({
        ...agent,
        roleType: agent.role,
        bindingRole: agent.role,
        activationRequired: agent.required,
        learnsFromGit: agent.git,
      }));
  const backendPreset = catalog?.presets?.find(item => item.key === preset);
  const keys = backendPreset
    ? new Set(backendPreset.agents)
    : preset === "minimal"
      ? new Set(["product_owner", "architect", "developer", "verifier", "governance"])
      : preset === "engineering_core"
        ? new Set(["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"])
        : new Set(backendAgents.map(agent => agent.key));
  return backendAgents.filter(agent => keys.has(agent.key));
}

const LOCAL_DISCOVERY_CAP = 500;
const LOCAL_FILE_SIZE_CAP = 250_000;
const LOCAL_PAYLOAD_CAP = 24_000_000;
const FIELD_CLASS = "w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-singularity-200";
const CAPABILITY_TYPE_OPTIONS = [
  { value: "DELIVERY", label: "Delivery" },
  { value: "COLLECTION", label: "Collection" },
] as const;
type CapabilityListTab = "active" | "archived";

export default function CapabilitiesPage() {
  const router = useRouter();
  const localInputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, mutate } = useSWR("runtime-capabilities-with-archive", () =>
    runtimeApi.listCapabilities({ includeArchived: true }),
  );
  const { data: iamTeams = [] } = useSWR<IamTeam[]>("iam-teams", () => identityApi.listTeams());
  const { data: iamBusinessUnits = [] } = useSWR<IamBusinessUnit[]>("iam-business-units", () => identityApi.listBusinessUnits());
  const { data: bootstrapAgentCatalog } = useSWR<BootstrapAgentCatalog>("bootstrap-agent-catalog", () => runtimeApi.bootstrapAgentCatalog() as Promise<BootstrapAgentCatalog>);
  const [showCreate, setShowCreate] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<BootstrapForm>(DEFAULT_FORM);
  const [localFiles, setLocalFiles] = useState<LocalBootstrapFile[]>([]);
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listTab, setListTab] = useState<CapabilityListTab>("active");
  const selectedAgents = agentPreviewForPreset(form.agentPreset, bootstrapAgentCatalog);
  const lockedAgentCount = selectedAgents.filter(agent => agent.locked).length;
  const gitGroundedAgentCount = selectedAgents.filter(agent => agent.learnsFromGit).length;
  const requiredAgentCount = selectedAgents.filter(agent => agent.activationRequired).length;
  const items = useMemo(() => capabilityRowsFromListResponse(data), [data]);
  const activeRawItems = useMemo(
    () => items.filter(cap => !isArchivedCapability(cap)),
    [items],
  );
  const archivedRawItems = useMemo(
    () => items.filter(isArchivedCapability),
    [items],
  );
  const activeItems = useMemo(
    () => uniqueCapabilitiesByIdentity(activeRawItems),
    [activeRawItems],
  );
  const archivedItems = useMemo(
    () => uniqueCapabilitiesByIdentity(archivedRawItems),
    [archivedRawItems],
  );
  const activeDuplicateGroups = useMemo(
    () => duplicateCapabilitiesByIdentity(activeRawItems),
    [activeRawItems],
  );
  const archivedDuplicateGroups = useMemo(
    () => duplicateCapabilitiesByIdentity(archivedRawItems),
    [archivedRawItems],
  );
  const activeIdentityKeys = useMemo(
    () => new Set(activeItems.map(capabilityIdentityKey).filter(Boolean)),
    [activeItems],
  );
  const archivedIdentityKeys = useMemo(
    () => new Set(archivedItems.map(capabilityIdentityKey).filter(Boolean)),
    [archivedItems],
  );
  const visibleItems = listTab === "archived" ? archivedItems : activeItems;
  const visibleDuplicateGroups = listTab === "archived" ? archivedDuplicateGroups : activeDuplicateGroups;
  const hiddenDuplicateCount = visibleDuplicateGroups.reduce((sum, group) => sum + group.duplicateCount, 0);
  const collectionCapabilities = useMemo(
    () => activeItems.filter(cap => isCollectionType(capabilityText(cap, "capabilityType", "capability_type"))),
    [activeItems],
  );
  const childCapabilityOptions = useMemo(
    () => activeItems.filter(cap => !isCollectionType(capabilityText(cap, "capabilityType", "capability_type"))),
    [activeItems],
  );
  const isCollection = isCollectionType(form.capabilityType);

  async function handleLocalDirectory(files: FileList) {
    setError(null);
    setLocalNote(null);
    const picked: LocalBootstrapFile[] = [];
    let bytes = 0;
    let skipped = 0;

    for (const file of Array.from(files)) {
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (!isBootstrapDiscoveryPath(path)) {
        skipped += 1;
        continue;
      }
      if (file.size > LOCAL_FILE_SIZE_CAP) {
        skipped += 1;
        continue;
      }
      const content = await file.text();
      bytes += content.length;
      if (bytes > LOCAL_PAYLOAD_CAP || picked.length >= LOCAL_DISCOVERY_CAP) {
        skipped += 1;
        break;
      }
      picked.push({ path, content });
    }

    setLocalFiles(picked);
    setLocalNote(`${picked.length} review-ready files selected${skipped ? `, ${skipped} skipped by safe limits` : ""}.`);
    if (localInputRef.current) localInputRef.current.value = "";
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError("Capability name is required.");
      setStep(1);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const documentLinks = form.documentLinks
        .split(/\n|,/)
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) => ({ url, artifactType: "DOC" }));
      const sharedApplications = form.sharedApplications
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
      const body = {
        name: form.name.trim(),
        appId: form.appId.trim() || undefined,
        capabilityType: form.capabilityType.trim() || "APPLICATION",
        criticality: form.criticality,
        description: form.description.trim() || undefined,
        businessUnitId: form.businessUnitId.trim() || undefined,
        ownerTeamId: form.ownerTeamId.trim() || undefined,
        parentCapabilityId: !isCollection && form.parentCapabilityId ? form.parentCapabilityId : undefined,
        childCapabilityIds: isCollection ? form.childCapabilityIds : [],
        sharedApplications: isCollection ? sharedApplications : [],
        targetWorkflowPattern: form.targetWorkflowPattern.trim() || undefined,
        agentPreset: form.agentPreset,
        repositories: form.githubUrl.trim()
          ? [{
              repoUrl: form.githubUrl.trim(),
              defaultBranch: form.githubBranch.trim() || "main",
              repositoryType: "GITHUB",
            }]
          : [],
        documentLinks,
        localFiles,
        // M61 Slice D — Operator-confirmed commands flow straight into
        // the bootstrap schema (testCommands / buildCommands). Server
        // writes them into CapabilityWorldModel after creating the row.
        testCommands: form.testCommands,
        buildCommands: form.buildCommands,
      };
      const run = await runtimeApi.bootstrapCapability(body);
      const capability = run.capability as Record<string, unknown> | undefined;
      const capabilityId = (capability?.id ?? run.capabilityId) as string | undefined;
      const runId = run.id as string | undefined;
      await mutate();
      if (capabilityId && runId) router.push(`/capabilities/${capabilityId}?bootstrapRunId=${runId}`);
      else {
        setShowCreate(false);
        setForm(DEFAULT_FORM);
        setLocalFiles([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bootstrap failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <PageHeader
          eyebrow="Agent Studio"
          icon={GitBranch}
          title="Capabilities"
          description="Onboard an application, learn from approved sources, and generate its starter agent set."
          actions={
            <button className="btn-primary" onClick={() => setShowCreate(true)}>
              <Sparkles size={16} /> Bootstrap Capability
            </button>
          }
        />
      </div>

      {showCreate && (
        <form onSubmit={handleBootstrap} className="card p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Capability-to-Agent-Team Factory</h2>
              <p className="text-sm text-slate-500 mt-1">
                Create the capability, draft its operating agent team, stage repo/doc learning, generate a starter workflow contract, then approve what enters runtime prompts.
              </p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mb-6">
            <SummaryCard icon={<Bot size={18} />} label="Agent team"
              value={`${selectedAgents.length} agents`}
              note={`${lockedAgentCount} locked gates, ${requiredAgentCount} activation-required.`} />
            <SummaryCard icon={<GitBranch size={18} />} label="Grounding"
              value={`${gitGroundedAgentCount} Git-aware`}
              note="Agents learn from approved repo/docs before runtime use." />
            <SummaryCard icon={<ShieldCheck size={18} />} label="Governance"
              value="Human reviewed"
              note="Generated agents and learned knowledge stay draft first." />
            <SummaryCard icon={<Layers3 size={18} />} label="Delivery pattern"
              value={form.targetWorkflowPattern.replace(/_/g, " ")}
              note="Starter workflow and artifacts are staged for review." />
          </div>

          <div className="grid grid-cols-5 gap-2 mb-6">
            {/* M61 Slice D — Inserted "Tests & Build" between Sources and Agents. */}
            {["Details", "Sources", "Tests & Build", "Agents", "Review"].map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => setStep(index + 1)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  step === index + 1
                    ? "border-singularity-500 bg-singularity-50 text-singularity-800"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                <div className="text-[10px] uppercase tracking-wide">Step {index + 1}</div>
                <div className="text-sm font-medium">{label === "Review" ? "Review packet" : label}</div>
              </button>
            ))}
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Field label="Name *">
                  <input className={FIELD_CLASS} required value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Core Common Rule Engine" />
                </Field>
                <Field label="App ID (optional)">
                  <input className={FIELD_CLASS} value={form.appId}
                    onChange={e => setForm(f => ({ ...f, appId: e.target.value }))}
                    maxLength={120}
                    placeholder="app-ccre, CMDB id, or portfolio id" />
                </Field>
                <Field label="Type">
                  <select className={FIELD_CLASS} value={form.capabilityType}
                    onChange={e => setForm(f => ({
                      ...f,
                      capabilityType: e.target.value,
                      parentCapabilityId: e.target.value === "COLLECTION" ? "" : f.parentCapabilityId,
                      childCapabilityIds: e.target.value === "COLLECTION" ? f.childCapabilityIds : [],
                      sharedApplications: e.target.value === "COLLECTION" ? f.sharedApplications : "",
                    }))}>
                    {CAPABILITY_TYPE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Field label="Criticality">
                  <select className={FIELD_CLASS} value={form.criticality}
                    onChange={e => setForm(f => ({ ...f, criticality: e.target.value }))}>
                    {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Owner team">
                  <SearchableSelect
                    placeholder={iamTeams.length > 0 ? "Search IAM team..." : "IAM team id"}
                    value={form.ownerTeamId}
                    options={iamTeams.map(team => ({
                      value: team.id,
                      label: team.name,
                      description: team.team_key ? `key: ${team.team_key}` : undefined,
                    }))}
                    fallbackFreeText={iamTeams.length === 0}
                    onChange={value => setForm(f => ({ ...f, ownerTeamId: value }))}
                  />
                </Field>
                <Field label="Business unit">
                  <SearchableSelect
                    placeholder={iamBusinessUnits.length > 0 ? "Search business unit..." : "IAM business unit id"}
                    value={form.businessUnitId}
                    options={iamBusinessUnits.map(bu => ({
                      value: bu.id,
                      label: bu.name,
                      description: bu.bu_key ? `key: ${bu.bu_key}` : undefined,
                    }))}
                    fallbackFreeText={iamBusinessUnits.length === 0}
                    onChange={value => setForm(f => ({ ...f, businessUnitId: value }))}
                  />
                </Field>
              </div>
              {isCollection ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Field label="Child capabilities">
                    <CapabilityMultiSelect
                      capabilities={childCapabilityOptions}
                      selectedIds={form.childCapabilityIds}
                      onChange={childCapabilityIds => setForm(f => ({ ...f, childCapabilityIds }))}
                    />
                  </Field>
                  <Field label="Shared applications">
                    <textarea rows={4} className={FIELD_CLASS} value={form.sharedApplications}
                      onChange={e => setForm(f => ({ ...f, sharedApplications: e.target.value }))}
                      placeholder={"One shared application per line, e.g. app-rule-engine, CMDB id, portfolio id"} />
                  </Field>
                </div>
              ) : (
                <Field label="Parent collection (optional)">
                  <SearchableSelect
                    placeholder={collectionCapabilities.length > 0 ? "Search parent collection..." : "No collection capability yet"}
                    value={form.parentCapabilityId}
                    options={collectionCapabilities
                      .map(cap => ({
                        value: capabilityRowId(cap),
                        label: capabilityDisplayName(cap),
                        description: capabilityText(cap, "appId", "app_id", "capabilityType", "capability_type"),
                      }))
                      .filter(option => option.value)}
                    onChange={value => setForm(f => ({ ...f, parentCapabilityId: value }))}
                  />
                </Field>
              )}
              <Field label="Target workflow pattern">
                <select className={FIELD_CLASS} value={form.targetWorkflowPattern}
                  onChange={e => setForm(f => ({ ...f, targetWorkflowPattern: e.target.value }))}>
                  <option value="governed_delivery">Governed delivery</option>
                  <option value="code_change">Code change with branch + QA</option>
                  <option value="security_review">Security review and remediation</option>
                  <option value="support_triage">Support triage and handoff</option>
                  <option value="release_readiness">Release readiness</option>
                </select>
              </Field>
              <Field label="Description">
                <textarea rows={3} className={FIELD_CLASS} value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What does this capability own, and what should agents learn about it?" />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Field label="Public GitHub URL">
                  <input className={FIELD_CLASS} value={form.githubUrl}
                    onChange={e => setForm(f => ({ ...f, githubUrl: e.target.value }))}
                    placeholder="https://github.com/org/repo" />
                </Field>
                <Field label="Branch">
                  <input className={FIELD_CLASS} value={form.githubBranch}
                    onChange={e => setForm(f => ({ ...f, githubBranch: e.target.value }))}
                    placeholder="main" />
                </Field>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  Polling stays disabled. Sync happens manually after human approval.
                </div>
              </div>
              <Field label="Documentation links">
                <textarea rows={3} className={FIELD_CLASS} value={form.documentLinks}
                  onChange={e => setForm(f => ({ ...f, documentLinks: e.target.value }))}
                  placeholder={"One URL per line, for public docs, runbooks, or API specs"} />
              </Field>
              <div className="rounded-xl border border-dashed border-slate-300 p-4 flex items-center gap-4">
                <Upload size={20} className="text-slate-500" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-800">Optional local source packet</p>
                  <p className="text-xs text-slate-500">
                    Select a directory. Only README, CLAUDE, AGENTS, SKILL, cursor/windsurf rules, and docs markdown are staged for review.
                  </p>
                  {localNote && <p className="text-xs text-emerald-700 mt-1">{localNote}</p>}
                </div>
                <input
                  ref={localInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={(e) => { if (e.target.files) void handleLocalDirectory(e.target.files); }}
                />
                <button type="button" className="btn-secondary" onClick={() => localInputRef.current?.click()}>
                  Pick directory
                </button>
              </div>
            </div>
          )}

          {/* M61 Slice D — Tests & Build. Captures the operator's authoritative
                test/build commands. Heuristics from the verifier-registry still
                run server-side; entries here are the explicit override. */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
                Add the commands an agent should run to test, lint, type-check,
                and build this capability. These are stored in the
                CapabilityWorldModel and surface as ambient prompt context — the
                agent stops discovering them per attempt and uses what you confirm
                here. Leave empty to fall back to heuristic detection at runtime.
              </div>
              <CommandTableEditor
                title="Test commands"
                hint='Examples: pnpm test (unit), pnpm test:int (integration), mvn -q -DskipITs=false verify (integration).'
                kinds={["unit", "integration", "e2e", "smoke", "lint", "typecheck"]}
                commands={form.testCommands}
                onChange={(testCommands) => setForm((f) => ({ ...f, testCommands }))}
                supportsTimingAndNetwork
              />
              <CommandTableEditor
                title="Build commands"
                hint='Examples: pnpm build, mvn -q -DskipTests package, cargo build --release.'
                kinds={["build", "package", "compile"]}
                commands={form.buildCommands}
                onChange={(buildCommands) => setForm((f) => ({ ...f, buildCommands }))}
              />
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <Field label="Agent team preset">
                <select className={FIELD_CLASS} value={form.agentPreset}
                  onChange={e => setForm(f => ({ ...f, agentPreset: e.target.value }))}>
                  {(bootstrapAgentCatalog?.presets?.length ? bootstrapAgentCatalog.presets : [
                    { key: "minimal", label: "Minimal governed crew", agents: [] },
                    { key: "engineering_core", label: "Engineering core crew", agents: [] },
                    { key: "governed_delivery", label: "Full governed delivery crew", agents: [] },
                  ]).map(preset => (
                    <option key={preset.key} value={preset.key}>{preset.label}</option>
                  ))}
                </select>
              </Field>
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
                Locked gates are mandatory and derived from platform baselines. Capability owners can activate them and use them, but only platform admins can edit their baseline behavior.
              </div>
              <div className="grid grid-cols-2 gap-3">
                {selectedAgents.map((agent) => {
                  const roleValue = agent.bindingRole ?? agent.roleType;
                  const role = CAPABILITY_ROLE_OPTIONS.find(item => item.value === roleValue || item.value === agent.roleType);
                  return (
                    <div key={agent.key} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Bot size={16} className="text-singularity-600" />
                        <span className="font-medium text-slate-900">{agent.label}</span>
                        <span className="text-[10px] uppercase tracking-wide bg-amber-50 text-amber-700 px-2 py-0.5 rounded">Draft</span>
                        {agent.locked && <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide bg-slate-900 text-white px-2 py-0.5 rounded"><Lock size={10} /> Locked</span>}
                        {agent.activationRequired && <span className="text-[10px] uppercase tracking-wide bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">Required</span>}
                        {agent.learnsFromGit && <span className="text-[10px] uppercase tracking-wide bg-purple-50 text-purple-700 px-2 py-0.5 rounded">Git grounded</span>}
                      </div>
                      <p className="text-sm text-slate-600">{agent.description ?? role?.description ?? "Capability-grounded operating agent."}</p>
                      {agent.grounding && <p className="text-xs text-slate-500 mt-2">{agent.grounding}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* M61 Slice D — step number bumped from 4 to 5 to make room for Tests & Build. */}
          {step === 5 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                <SummaryCard icon={<Layers3 size={18} />} label="Learning packet"
                  value={`${sourceCount(form, localFiles)} source groups`}
                  note="Findings are staged as pending candidates. Nothing enters prompt retrieval until approval." />
                <SummaryCard icon={<ShieldCheck size={18} />} label="Runtime safety"
                  value="Approval gated"
                  note="Generated agents and learning candidates are draft until the review page activates them." />
                <SummaryCard icon={<FileText size={18} />} label="Discovery signals"
                  value={`${localFiles.length} local files`}
                  note="README, AGENTS, CLAUDE, SKILL, docs, and editor rule files are prioritized." />
                <SummaryCard icon={<GitBranch size={18} />} label="Starter workflow"
                  value={form.targetWorkflowPattern.replace(/_/g, " ")}
                  note="The operating model packet includes a suggested governed workflow, artifact gates, and activation review." />
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ShieldCheck size={18} className="text-emerald-600" />
                  <h3 className="font-semibold text-slate-900">Activation checklist</h3>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
                  <ChecklistItem ok={Boolean(form.name.trim())} label="Capability identity captured" />
                  <ChecklistItem ok={Boolean(form.ownerTeamId || iamTeams.length === 0)} label="Owner team selected or dev fallback allowed" />
                  <ChecklistItem ok={form.capabilityType === "DELIVERY" || form.childCapabilityIds.length > 0 || Boolean(form.sharedApplications.trim())} label="Collection links child capabilities or shared applications" />
                  <ChecklistItem ok={sourceCount(form, localFiles) > 0} label="At least one learning source attached" />
                  <ChecklistItem ok={lockedAgentCount > 0} label="Locked governance gates included" />
                  <ChecklistItem ok={requiredAgentCount > 0} label="Required verifier/security/governance activation planned" />
                  <ChecklistItem ok={selectedAgents.length >= 3} label="Delivery team has enough roles to start" />
                </div>
              </div>
            </div>
          )}

          {error && <div className="mt-4"><ErrorState error={error} compact /></div>}

          <div className="mt-6 flex items-center justify-between">
            <button type="button" className="btn-secondary" disabled={step === 1}
              onClick={() => setStep(s => Math.max(1, s - 1))}>
              Back
            </button>
            {/* M61 Slice D — Wizard max bumped from 4 to 5 (Tests & Build added). */}
            {step < 5 ? (
              <button type="button" className="btn-primary" onClick={() => setStep(s => Math.min(5, s + 1))}>
                Continue <ChevronRight size={14} />
              </button>
            ) : (
              <button className="btn-primary" disabled={creating || !form.name.trim()}>
                {creating ? "Staging operating model..." : "Create + Stage Review"}
              </button>
            )}
          </div>
        </form>
      )}

      {isLoading && <div className="text-slate-500 text-sm">Loading...</div>}

      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <button
          type="button"
          onClick={() => setListTab("active")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            listTab === "active"
              ? "bg-emerald-50 text-emerald-700 shadow-sm"
              : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          }`}
        >
          Active <span className="ml-1 text-xs opacity-70">{activeItems.length}</span>
        </button>
        <button
          type="button"
          onClick={() => setListTab("archived")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            listTab === "archived"
              ? "bg-slate-900 text-white shadow-sm"
              : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          }`}
        >
          Archived <span className="ml-1 text-xs opacity-70">{archivedItems.length}</span>
        </button>
      </div>

      {visibleDuplicateGroups.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-700">
              <AlertTriangle size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-amber-950">Duplicate capability identities detected</div>
              <p className="mt-1 text-amber-900">
                Showing the deterministic canonical row for each app/name identity and hiding {hiddenDuplicateCount} duplicate
                {hiddenDuplicateCount === 1 ? " row" : " rows"}. This usually means old data was created before
                idempotent sync or active-identity constraints were applied.
              </p>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {visibleDuplicateGroups.slice(0, 4).map(group => (
                  <div key={group.key} className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2">
                    <div className="font-medium text-slate-900">{capabilityIdentityLabel(group.canonical)}</div>
                    <div className="mt-1 text-xs text-slate-600">
                      Canonical {capabilityShortId(group.canonical)}; hidden{" "}
                      {group.duplicateIds.map(capabilityShortId).join(", ")}
                    </div>
                  </div>
                ))}
              </div>
              {visibleDuplicateGroups.length > 4 && (
                <div className="mt-2 text-xs text-amber-800">
                  {visibleDuplicateGroups.length - 4} more duplicate identity group
                  {visibleDuplicateGroups.length - 4 === 1 ? "" : "s"} hidden from this summary.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {visibleItems.map((c, index) => {
          const rowId = capabilityRowId(c);
          if (!rowId) return null;
          const identityKey = capabilityIdentityKey(c);
          const displayName = capabilityDisplayName(c);
          const status = capabilityText(c, "status") || "UNKNOWN";
          const appId = capabilityText(c, "appId", "app_id", "applicationId", "application_id");
          const capabilityType = capabilityText(c, "capabilityType", "capability_type");
          const criticality = capabilityText(c, "criticality");
          const description = capabilityText(c, "description");
          const hasCounterpart = Boolean(identityKey && (
            listTab === "archived" ? activeIdentityKeys.has(identityKey) : archivedIdentityKeys.has(identityKey)
          ));
          return (
            <Link key={rowId || `${displayName}-${index}`} href={`/capabilities/${encodeURIComponent(rowId)}`}
              className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
              <div className={`p-2.5 rounded-lg ${listTab === "archived" ? "bg-slate-100" : "bg-purple-50"}`}>
                <GitBranch size={20} className={listTab === "archived" ? "text-slate-500" : "text-purple-600"} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-slate-900">{displayName}</span>
                  <StatusBadge value={status} />
                  {!!appId && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">app: {appId}</span>}
                  {!!capabilityType && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{capabilityType}</span>}
                  {!!criticality && <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">crit: {criticality}</span>}
                  {hasCounterpart && (
                    <span className="text-xs text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                      {listTab === "archived" ? "active copy exists" : "archived copy exists"}
                    </span>
                  )}
                </div>
                {!!description && <div className="text-sm text-slate-600 mt-1">{description}</div>}
              </div>
              <ChevronRight size={16} className="text-slate-400 shrink-0" />
            </Link>
          );
        })}
        {!isLoading && visibleItems.length === 0 && (
          <EmptyState
            icon={GitBranch}
            title={listTab === "archived" ? "No archived capabilities" : "No active capabilities yet"}
            hint={listTab === "archived" ? "Archived capabilities will appear here after they are retired." : "Bootstrap your first one above."}
          />
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

/**
 * M61 Slice D — Editable table of test/build commands used in the
 * Tests & Build wizard step.
 *
 * Per row: kind dropdown + cmd input + (optional) cwd + (optional)
 * expectedDurationSec + (optional) requiresNetwork checkbox.
 *
 * `supportsTimingAndNetwork` toggles the last two columns; build
 * commands don't need them, test commands do.
 *
 * The component is a controlled list — the parent owns the array.
 * Clicking "Add" appends a row with kind=kinds[0] + empty cmd; the
 * parent's onChange fires on every keystroke so we don't need a
 * separate "save" step.
 *
 * M61 Wire D — Per-row "Verify" button runs the command in an isolated
 * tmp dir via agent-runtime's probe endpoint and renders an inline
 * chip with the exit code + duration. Pre-create the capabilityId is
 * "_new_" (the route param is a soft anchor — the probe service
 * doesn't read capability state).
 */
type ProbeResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
};

function CommandTableEditor({
  title,
  hint,
  kinds,
  commands,
  onChange,
  supportsTimingAndNetwork,
  capabilityId,
}: {
  title: string;
  hint: string;
  kinds: string[];
  commands: WizardCommand[];
  onChange: (next: WizardCommand[]) => void;
  supportsTimingAndNetwork?: boolean;
  capabilityId?: string;
}) {
  const [probeResults, setProbeResults] = useState<Record<number, ProbeResult>>({});
  const [probeRunning, setProbeRunning] = useState<Record<number, boolean>>({});

  const patch = (idx: number, change: Partial<WizardCommand>) => {
    const next = commands.slice();
    next[idx] = { ...next[idx], ...change };
    onChange(next);
  };
  const add = () => {
    onChange([...commands, { kind: kinds[0] ?? "unit", cmd: "" }]);
  };
  const remove = (idx: number) => {
    const next = commands.slice();
    next.splice(idx, 1);
    onChange(next);
    // Drop any stale probe result so a re-add doesn't display the
    // old one (indices are reused after splice).
    setProbeResults((prev) => {
      const next: Record<number, ProbeResult> = {};
      for (const [k, v] of Object.entries(prev)) {
        const n = Number(k);
        if (n < idx) next[n] = v;
        else if (n > idx) next[n - 1] = v;
      }
      return next;
    });
  };
  const verify = async (idx: number) => {
    const row = commands[idx];
    if (!row || !row.cmd.trim()) return;
    setProbeRunning((p) => ({ ...p, [idx]: true }));
    try {
      // capabilityId fallback "_new_" is what the wizard sends before
      // the capability row exists. The probe endpoint ignores the
      // param so this is fine.
      const out = await runtimeApi.probeCommand(capabilityId ?? "_new_", {
        cmd: row.cmd,
        cwd: row.cwd,
      }) as ProbeResult;
      setProbeResults((p) => ({ ...p, [idx]: out }));
    } catch (err) {
      setProbeResults((p) => ({
        ...p,
        [idx]: {
          exitCode: -1, signal: null, timedOut: false,
          durationMs: 0, stderr: (err as Error).message,
        },
      }));
    } finally {
      setProbeRunning((p) => ({ ...p, [idx]: false }));
    }
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button type="button" className="btn-secondary text-xs" onClick={add}>
          + Add row
        </button>
      </div>
      {commands.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">
          None — heuristic detection will run at first workflow.
        </p>
      ) : (
        <div className="space-y-2">
          {commands.map((cmd, idx) => {
            const probe = probeResults[idx];
            const running = probeRunning[idx];
            // M61 Wire D — colour the chip by exit-code class:
            //   0          → ok (green)
            //   1-2 / 126  → warn (amber) — typical "would run in real repo"
            //   127 / -1   → error (red) — binary missing or fetch failed
            //   timeout    → amber
            //   any other  → slate
            const chipTone: "ok" | "warn" | "err" | "info" | "none" = !probe
              ? "none"
              : probe.timedOut
                ? "warn"
                : probe.exitCode === 0
                  ? "ok"
                  : probe.exitCode === -1 || probe.exitCode === 127
                    ? "err"
                    : probe.exitCode != null && probe.exitCode > 0 && probe.exitCode < 126
                      ? "warn"
                      : "info";
            const chipClass = chipTone === "ok" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : chipTone === "warn" ? "bg-amber-50 text-amber-700 border-amber-200"
              : chipTone === "err" ? "bg-red-50 text-red-700 border-red-200"
              : chipTone === "info" ? "bg-slate-50 text-slate-700 border-slate-200"
              : "";
            const chipLabel = !probe ? ""
              : probe.timedOut ? `timeout · ${probe.durationMs}ms`
              : probe.exitCode === null ? `signal ${probe.signal ?? "?"}`
              : `exit ${probe.exitCode} · ${probe.durationMs}ms`;
            return (
              <div key={idx} className="space-y-1">
                <div className="grid grid-cols-12 gap-2 items-center">
                  <select
                    className={`${FIELD_CLASS} col-span-2 text-xs`}
                    value={cmd.kind}
                    onChange={(e) => patch(idx, { kind: e.target.value })}
                  >
                    {kinds.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <input
                    className={`${FIELD_CLASS} col-span-${supportsTimingAndNetwork ? 3 : 5} text-xs font-mono`}
                    value={cmd.cmd}
                    placeholder="pnpm test"
                    onChange={(e) => patch(idx, { cmd: e.target.value })}
                  />
                  <input
                    className={`${FIELD_CLASS} col-span-2 text-xs font-mono`}
                    value={cmd.cwd ?? ""}
                    placeholder="cwd (opt)"
                    onChange={(e) => patch(idx, { cwd: e.target.value || undefined })}
                  />
                  {supportsTimingAndNetwork ? (
                    <>
                      <input
                        className={`${FIELD_CLASS} col-span-1 text-xs`}
                        type="number"
                        min={1}
                        max={3600}
                        value={cmd.expectedDurationSec ?? ""}
                        placeholder="sec"
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          patch(idx, {
                            expectedDurationSec: Number.isFinite(n) && n > 0 ? n : undefined,
                          });
                        }}
                      />
                      <label className="col-span-1 inline-flex items-center gap-1 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={Boolean(cmd.requiresNetwork)}
                          onChange={(e) => patch(idx, { requiresNetwork: e.target.checked })}
                        />
                        net
                      </label>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className={`col-span-2 text-xs ${running ? "btn-secondary opacity-50" : "btn-secondary"}`}
                    disabled={!cmd.cmd.trim() || running}
                    onClick={() => verify(idx)}
                    title="Spawn this command in an isolated tmp dir (10s cap) to sanity-check syntax."
                  >
                    {running ? "↻ Verifying..." : "▶ Verify"}
                  </button>
                  <button
                    type="button"
                    className="col-span-1 text-xs text-red-600 hover:underline"
                    onClick={() => remove(idx)}
                    aria-label="Remove row"
                  >
                    ✕
                  </button>
                </div>
                {probe ? (
                  <div className="pl-2 flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono border ${chipClass}`}>
                      {chipLabel}
                    </span>
                    {probe.stderr ? (
                      <span className="text-[10px] text-slate-500 truncate font-mono" title={probe.stderr}>
                        {probe.stderr.slice(0, 120)}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SelectOption = { value: string; label: string; description?: string };

function SearchableSelect({
  value,
  options,
  placeholder,
  fallbackFreeText = false,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  placeholder: string;
  fallbackFreeText?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = options.find(option => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? value);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const next = options.find(option => option.value === value);
    setQuery(next?.label ?? value);
  }, [options, value]);

  const filtered = options
    .filter(option => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  if (fallbackFreeText) {
    return (
      <input className={FIELD_CLASS} value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder} />
    );
  }

  return (
    <div className="relative">
      <input
        className={FIELD_CLASS}
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={e => {
          setQuery(e.target.value);
          setOpen(true);
          if (!e.target.value) onChange("");
        }}
      />
      {value && (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400 hover:text-slate-700"
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(false);
          }}
        >
          Clear
        </button>
      )}
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filtered.length > 0 ? filtered.map(option => (
            <button
              key={option.value}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setQuery(option.label);
                setOpen(false);
              }}
            >
              <span className="block font-medium text-slate-800">{option.label}</span>
              {option.description && <span className="block text-xs text-slate-500">{option.description}</span>}
            </button>
          )) : (
            <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

function CapabilityMultiSelect({
  capabilities,
  selectedIds,
  onChange,
}: {
  capabilities: Record<string, unknown>[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set(selectedIds);
  const filtered = capabilities
    .filter(cap => capabilityLabel(cap).toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <input
        className="mb-2 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-singularity-200"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search existing application/delivery capabilities..."
      />
      <div className="max-h-44 space-y-1 overflow-auto">
        {filtered.length > 0 ? filtered.map(cap => {
          const id = capabilityRowId(cap);
          if (!id) return null;
          const checked = selected.has(id);
          return (
            <button
              key={id}
              type="button"
              className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm ${checked ? "bg-singularity-50 text-singularity-800" : "hover:bg-slate-50 text-slate-700"}`}
              onClick={() => {
                const next = new Set(selected);
                if (checked) next.delete(id);
                else next.add(id);
                onChange(Array.from(next));
              }}
            >
              <span>
                <span className="block font-medium">{capabilityLabel(cap)}</span>
                <span className="block text-xs text-slate-500">{capabilityText(cap, "capabilityType", "capability_type") || "capability"}</span>
              </span>
              <span className="text-xs font-semibold">{checked ? "Selected" : "Add"}</span>
            </button>
          );
        }) : (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-400">No capabilities found.</div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2 text-singularity-700 mb-2">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      <p className="text-xs text-slate-500 mt-1">{note}</p>
    </div>
  );
}

function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${ok ? "border-emerald-100 bg-emerald-50 text-emerald-800" : "border-amber-100 bg-amber-50 text-amber-800"}`}>
      {ok ? <ShieldCheck size={14} /> : <Lock size={14} />}
      <span>{label}</span>
    </div>
  );
}

function sourceCount(form: BootstrapForm, localFiles: LocalBootstrapFile[]): number {
  const docs = form.documentLinks.split(/\n|,/).map(s => s.trim()).filter(Boolean).length;
  return (form.githubUrl.trim() ? 1 : 0) + docs + (localFiles.length ? 1 : 0);
}

function isCollectionType(value: string): boolean {
  return value.trim().toUpperCase().includes("COLLECTION");
}

function capabilityLabel(cap: Record<string, unknown>): string {
  const name = capabilityDisplayName(cap);
  const appId = capabilityText(cap, "appId", "app_id", "applicationId", "application_id");
  return appId ? `${name} (${appId})` : name;
}

function isBootstrapDiscoveryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (/^README(\..*)?$/i.test(name)) return true;
  if (/^(CLAUDE|AGENTS)\.md$/i.test(name)) return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  if (normalized.includes("/.github/copilot-instructions.md")) return true;
  if (normalized.includes(".cursor/rules/")) return true;
  if (name === ".cursorrules" || name === ".windsurfrules") return true;
  if (normalized.includes("/.claude/") || normalized.startsWith(".claude/")) return true;
  if (/(\.codex\/skills\/|\/)?SKILL\.md$/i.test(normalized)) return true;
  if (/(^|\/)docs\/.+\.md$/i.test(normalized)) return true;
  return false;
}
