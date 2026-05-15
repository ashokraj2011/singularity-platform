"use client";
import { useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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

type LocalBootstrapFile = { path: string; content: string };

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
};

const DEFAULT_FORM: BootstrapForm = {
  name: "",
  appId: "",
  capabilityType: "APPLICATION",
  criticality: "MEDIUM",
  description: "",
  businessUnitId: "",
  ownerTeamId: "",
  githubUrl: "",
  githubBranch: "main",
  documentLinks: "",
  targetWorkflowPattern: "governed_delivery",
  agentPreset: "governed_delivery",
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

function agentPreviewForPreset(preset: string) {
  const keys = preset === "minimal"
    ? new Set(["product_owner", "architect", "developer", "verifier", "governance"])
    : preset === "engineering_core"
      ? new Set(["product_owner", "business_analyst", "architect", "developer", "verifier", "qa", "security", "devops", "governance"])
      : new Set(BOOTSTRAP_AGENT_PREVIEW.map(agent => agent.key));
  return BOOTSTRAP_AGENT_PREVIEW.filter(agent => keys.has(agent.key));
}

const LOCAL_DISCOVERY_CAP = 500;
const LOCAL_FILE_SIZE_CAP = 250_000;
const LOCAL_PAYLOAD_CAP = 24_000_000;
const FIELD_CLASS = "w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-singularity-200";

export default function CapabilitiesPage() {
  const router = useRouter();
  const localInputRef = useRef<HTMLInputElement>(null);
  const { data, isLoading, mutate } = useSWR("runtime-capabilities", () => runtimeApi.listCapabilities());
  const { data: iamTeams = [] } = useSWR<IamTeam[]>("iam-teams", () => identityApi.listTeams());
  const { data: iamBusinessUnits = [] } = useSWR<IamBusinessUnit[]>("iam-business-units", () => identityApi.listBusinessUnits());
  const [showCreate, setShowCreate] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<BootstrapForm>(DEFAULT_FORM);
  const [localFiles, setLocalFiles] = useState<LocalBootstrapFile[]>([]);
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const body = {
        name: form.name.trim(),
        appId: form.appId.trim() || undefined,
        capabilityType: form.capabilityType.trim() || "APPLICATION",
        criticality: form.criticality,
        description: form.description.trim() || undefined,
        businessUnitId: form.businessUnitId.trim() || undefined,
        ownerTeamId: form.ownerTeamId.trim() || undefined,
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

  const items = (data ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Capabilities</h1>
          <p className="text-slate-500 mt-1">Onboard an application, learn from approved sources, and generate its starter agent set.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Sparkles size={16} /> Bootstrap Capability
        </button>
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

          <div className="grid grid-cols-4 gap-2 mb-6">
            {["Details", "Sources", "Agents", "Review"].map((label, index) => (
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
                  <input className={FIELD_CLASS} value={form.capabilityType}
                    onChange={e => setForm(f => ({ ...f, capabilityType: e.target.value }))}
                    placeholder="APPLICATION" />
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
                  {iamTeams.length > 0 ? (
                    <select className={FIELD_CLASS} value={form.ownerTeamId}
                      onChange={e => setForm(f => ({ ...f, ownerTeamId: e.target.value }))}>
                      <option value="">Select IAM team…</option>
                      {iamTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                  ) : (
                    <input className={FIELD_CLASS} value={form.ownerTeamId}
                      onChange={e => setForm(f => ({ ...f, ownerTeamId: e.target.value }))}
                      placeholder="IAM team id" />
                  )}
                </Field>
                <Field label="Business unit">
                  {iamBusinessUnits.length > 0 ? (
                    <select className={FIELD_CLASS} value={form.businessUnitId}
                      onChange={e => setForm(f => ({ ...f, businessUnitId: e.target.value }))}>
                      <option value="">Select IAM business unit…</option>
                      {iamBusinessUnits.map(bu => <option key={bu.id} value={bu.id}>{bu.name}</option>)}
                    </select>
                  ) : (
                    <input className={FIELD_CLASS} value={form.businessUnitId}
                      onChange={e => setForm(f => ({ ...f, businessUnitId: e.target.value }))}
                      placeholder="IAM business unit id" />
                  )}
                </Field>
              </div>
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

          {step === 3 && (
            <div className="space-y-4">
              <Field label="Agent team preset">
                <select className={FIELD_CLASS} value={form.agentPreset}
                  onChange={e => setForm(f => ({ ...f, agentPreset: e.target.value }))}>
                  <option value="minimal">Minimal governed crew</option>
                  <option value="engineering_core">Engineering core crew</option>
                  <option value="governed_delivery">Full governed delivery crew</option>
                </select>
              </Field>
              <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
                Locked gates are mandatory and derived from platform baselines. Capability owners can activate them and use them, but only platform admins can edit their baseline behavior.
              </div>
              <div className="grid grid-cols-2 gap-3">
                {agentPreviewForPreset(form.agentPreset).map((agent) => {
                  const role = CAPABILITY_ROLE_OPTIONS.find(item => item.value === agent.role);
                  return (
                    <div key={agent.key} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Bot size={16} className="text-singularity-600" />
                        <span className="font-medium text-slate-900">{agent.label}</span>
                        <span className="text-[10px] uppercase tracking-wide bg-amber-50 text-amber-700 px-2 py-0.5 rounded">Draft</span>
                        {agent.locked && <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide bg-slate-900 text-white px-2 py-0.5 rounded"><Lock size={10} /> Locked</span>}
                        {agent.required && <span className="text-[10px] uppercase tracking-wide bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">Required</span>}
                        {agent.git && <span className="text-[10px] uppercase tracking-wide bg-purple-50 text-purple-700 px-2 py-0.5 rounded">Git grounded</span>}
                      </div>
                      <p className="text-sm text-slate-600">{role?.description ?? "Capability-grounded operating agent."}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="grid grid-cols-3 gap-4">
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
          )}

          {error && <div className="mt-4 text-sm text-red-600">{error}</div>}

          <div className="mt-6 flex items-center justify-between">
            <button type="button" className="btn-secondary" disabled={step === 1}
              onClick={() => setStep(s => Math.max(1, s - 1))}>
              Back
            </button>
            {step < 4 ? (
              <button type="button" className="btn-primary" onClick={() => setStep(s => Math.min(4, s + 1))}>
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

      <div className="space-y-3">
        {items.map(c => (
          <Link key={c.id as string} href={`/capabilities/${c.id}`}
            className="card p-5 flex items-center gap-4 hover:shadow-md transition-shadow">
            <div className="p-2.5 bg-purple-50 rounded-lg"><GitBranch size={20} className="text-purple-600" /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900">{c.name as string}</span>
                <StatusBadge value={c.status as string} />
                {!!c.appId && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">app: {c.appId as string}</span>}
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
            <p>No capabilities yet. Bootstrap your first one above.</p>
          </div>
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

function sourceCount(form: BootstrapForm, localFiles: LocalBootstrapFile[]): number {
  const docs = form.documentLinks.split(/\n|,/).map(s => s.trim()).filter(Boolean).length;
  return (form.githubUrl.trim() ? 1 : 0) + docs + (localFiles.length ? 1 : 0);
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
