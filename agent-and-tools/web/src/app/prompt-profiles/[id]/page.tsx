"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  CheckCircle2,
  FileText,
  GitBranch,
  Layers,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const SECTIONS = [
  {
    key: "core",
    title: "Core Behavior",
    description: "Identity, role, operating principles, and durable agent habits.",
    icon: Brain,
    color: "emerald",
    defaultPriority: 100,
    defaultLayerType: "AGENT_ROLE",
    layerTypes: ["PLATFORM_CONSTITUTION", "AGENT_ROLE", "SKILL_CONTRACT"],
  },
  {
    key: "capability",
    title: "Capability Knowledge",
    description: "Capability, repository, business-unit, tenant, and durable memory context.",
    icon: FileText,
    color: "indigo",
    defaultPriority: 220,
    defaultLayerType: "CAPABILITY_CONTEXT",
    layerTypes: ["TENANT_CONTEXT", "BUSINESS_UNIT_CONTEXT", "CAPABILITY_CONTEXT", "REPOSITORY_CONTEXT", "MEMORY_CONTEXT"],
  },
  {
    key: "tools",
    title: "Tools & Permissions",
    description: "Tool rules, approval policy, and data-access guardrails.",
    icon: Wrench,
    color: "amber",
    defaultPriority: 500,
    defaultLayerType: "TOOL_CONTRACT",
    layerTypes: ["TOOL_CONTRACT", "APPROVAL_POLICY", "DATA_ACCESS_POLICY"],
  },
  {
    key: "workflow",
    title: "Workflow / Stage Instructions",
    description: "Workflow and phase-specific instructions layered over the base profile.",
    icon: GitBranch,
    color: "sky",
    defaultPriority: 350,
    defaultLayerType: "WORKFLOW_CONTEXT",
    layerTypes: ["WORKFLOW_CONTEXT", "PHASE_CONTEXT"],
  },
  {
    key: "output",
    title: "Output Contract",
    description: "Response shape, required evidence, and final deliverable standards.",
    icon: ShieldCheck,
    color: "violet",
    defaultPriority: 950,
    defaultLayerType: "OUTPUT_CONTRACT",
    layerTypes: ["OUTPUT_CONTRACT"],
  },
  {
    key: "runtime",
    title: "Runtime Evidence",
    description: "Evidence and task context usually injected during execution audit.",
    icon: Sparkles,
    color: "rose",
    defaultPriority: 600,
    defaultLayerType: "RUNTIME_EVIDENCE",
    layerTypes: ["RUNTIME_EVIDENCE", "TASK_CONTEXT"],
  },
  {
    key: "advanced",
    title: "Advanced / Other",
    description: "Specialized prompt blocks that do not map cleanly to a standard section.",
    icon: SlidersHorizontal,
    color: "slate",
    defaultPriority: 800,
    defaultLayerType: "PLATFORM_CONSTITUTION",
    layerTypes: [],
  },
] as const;

const ALL_LAYER_TYPES = [
  "PLATFORM_CONSTITUTION", "TENANT_CONTEXT", "BUSINESS_UNIT_CONTEXT", "AGENT_ROLE",
  "SKILL_CONTRACT", "TOOL_CONTRACT", "CAPABILITY_CONTEXT", "REPOSITORY_CONTEXT",
  "WORKFLOW_CONTEXT", "PHASE_CONTEXT", "TASK_CONTEXT", "RUNTIME_EVIDENCE",
  "MEMORY_CONTEXT", "OUTPUT_CONTRACT", "APPROVAL_POLICY", "DATA_ACCESS_POLICY",
];

const SCOPE_TYPES = ["PLATFORM", "TENANT", "BUSINESS_UNIT", "CAPABILITY", "AGENT_TEMPLATE", "AGENT_BINDING", "WORKFLOW", "WORKFLOW_PHASE", "EXECUTION"];

type Section = typeof SECTIONS[number];
type NewLayerForm = {
  name: string;
  content: string;
  layerType: string;
  scopeType: string;
  scopeId: string;
  isRequired: boolean;
};

function sectionForLayerType(layerType: string): Section {
  return SECTIONS.find(section => section.layerTypes.includes(layerType as never)) ?? SECTIONS[SECTIONS.length - 1];
}

function sectionByKey(key: string): Section {
  return SECTIONS.find(section => section.key === key) ?? SECTIONS[0];
}

function labelize(value: unknown) {
  return String(value || "").replace(/_/g, " ").toLowerCase();
}

function colorClasses(color: Section["color"]) {
  switch (color) {
    case "emerald":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "indigo":
      return "bg-indigo-50 text-indigo-700 border-indigo-100";
    case "amber":
      return "bg-amber-50 text-amber-700 border-amber-100";
    case "sky":
      return "bg-sky-50 text-sky-700 border-sky-100";
    case "violet":
      return "bg-violet-50 text-violet-700 border-violet-100";
    case "rose":
      return "bg-rose-50 text-rose-700 border-rose-100";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

function shortHash(value: unknown) {
  const raw = String(value || "");
  if (!raw) return "not recorded";
  return raw.length > 24 ? `${raw.slice(0, 24)}...` : raw;
}

function runtimeNote(sectionKey: string) {
  if (sectionKey === "capability") return "Capability metadata, knowledge, memory, and code context can also be added automatically at execution time.";
  if (sectionKey === "tools") return "Tool contracts are resolved from grants and discovery during execution, then stored in the prompt assembly.";
  if (sectionKey === "runtime") return "Runtime evidence and task context are typically visible in execution audit, not hand-maintained here.";
  if (sectionKey === "workflow") return "Workflow and phase-specific layers can be injected when a node executes in a workflow.";
  return "This section is normally human-authored in the behavior profile.";
}

export default function PromptProfileDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const { data: profile, error: profileError, isLoading: profileLoading, mutate: mutateProfile } = useSWR(`profile-${id}`, () => runtimeApi.getProfile(id));
  const { data: allLayers, error: layersError, mutate: mutateLayers } = useSWR("all-layers", () => runtimeApi.listLayers());

  const [selectedSectionKey, setSelectedSectionKey] = useState<Section["key"]>("core");
  const [layerId, setLayerId] = useState("");
  const [advancedAudit, setAdvancedAudit] = useState(false);
  const [manualPriority, setManualPriority] = useState<number>(SECTIONS[0].defaultPriority);
  const [attachMode, setAttachMode] = useState<"existing" | "new">("existing");
  const [creating, setCreating] = useState(false);
  const [newLayer, setNewLayer] = useState<NewLayerForm>({
    name: "",
    content: "",
    layerType: SECTIONS[0].defaultLayerType,
    scopeType: "AGENT_TEMPLATE",
    scopeId: "",
    isRequired: false,
  });

  const selectedSection = sectionByKey(selectedSectionKey);
  const layers = ((profile as Record<string, unknown> | undefined)?.layers as Array<Record<string, unknown>> | undefined) ?? [];
  const layerOptions = ((allLayers ?? []) as Record<string, unknown>[]).filter(layer => {
    if (selectedSection.key === "advanced") return true;
    return selectedSection.layerTypes.includes(String(layer.layerType ?? "") as never);
  });

  const groupedLayers = useMemo(() => {
    return SECTIONS.map(section => ({
      section,
      links: layers
        .filter(link => {
          const layer = (link.promptLayer ?? {}) as Record<string, unknown>;
          return sectionForLayerType(String(layer.layerType ?? "")).key === section.key;
        })
        .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0)),
    }));
  }, [layers]);

  function handleSectionChange(key: string) {
    const next = sectionByKey(key);
    setSelectedSectionKey(next.key);
    setManualPriority(next.defaultPriority);
    setLayerId("");
    setNewLayer(layer => ({
      ...layer,
      layerType: next.defaultLayerType,
      scopeType: next.key === "workflow" ? "WORKFLOW_PHASE" : next.key === "capability" ? "CAPABILITY" : "AGENT_TEMPLATE",
    }));
  }

  async function attachExisting() {
    if (!layerId) return;
    await runtimeApi.attachLayerToProfile(id, {
      promptLayerId: layerId,
      priority: advancedAudit ? manualPriority : selectedSection.defaultPriority,
      isEnabled: true,
    } as never);
    setLayerId("");
    await mutateProfile();
  }

  async function createAndAttach() {
    if (!newLayer.name.trim() || !newLayer.content.trim()) return;
    setCreating(true);
    try {
      const created = await runtimeApi.createLayer({
        name: newLayer.name.trim(),
        layerType: newLayer.layerType,
        scopeType: newLayer.scopeType,
        scopeId: advancedAudit && newLayer.scopeId.trim() ? newLayer.scopeId.trim() : undefined,
        content: newLayer.content,
        priority: advancedAudit ? manualPriority : selectedSection.defaultPriority,
        isRequired: newLayer.isRequired,
      } as never) as Record<string, unknown>;

      await runtimeApi.attachLayerToProfile(id, {
        promptLayerId: created.id,
        priority: advancedAudit ? manualPriority : selectedSection.defaultPriority,
        isEnabled: true,
      } as never);

      setNewLayer(layer => ({ ...layer, name: "", content: "", scopeId: "", isRequired: false }));
      await Promise.all([mutateProfile(), mutateLayers()]);
    } finally {
      setCreating(false);
    }
  }

  if (profileLoading) {
    return (
      <div className="space-y-4">
        <div className="card p-6 animate-pulse">
          <div className="h-5 w-72 rounded bg-slate-200" />
          <div className="mt-3 h-3 w-1/2 rounded bg-slate-100" />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map(i => <div key={i} className="card h-28 animate-pulse bg-white" />)}
        </div>
      </div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className="card border-red-200 bg-red-50 p-6 text-red-800">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <h1 className="font-semibold">Behavior profile could not be loaded.</h1>
            <p className="mt-1 text-sm text-red-700">The prompt-composer profile endpoint returned an error or no profile.</p>
          </div>
          <button className="btn-secondary bg-white" onClick={() => mutateProfile()}>
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  const p = profile as Record<string, unknown>;
  const activeSections = groupedLayers.filter(group => group.links.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="section-card overflow-hidden">
        <div className="p-6 border-b border-slate-200 bg-gradient-to-br from-white to-emerald-50/50">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
                  <Brain size={14} />
                  Agent Behavior Profile
                </span>
                <StatusBadge value={p.status as string} />
                {!!p.ownerScopeType && (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                    Used by {labelize(p.ownerScopeType)}
                  </span>
                )}
              </div>
              <h1 className="mt-4 text-3xl font-bold text-slate-950">{p.name as string}</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {(p.description as string | undefined) || "Reusable human-authored behavior that can be attached to agent templates or runtime bindings."}
              </p>
            </div>
            <button
              type="button"
              className={advancedAudit ? "btn-primary" : "btn-secondary bg-white"}
              onClick={() => setAdvancedAudit(v => !v)}
            >
              <SlidersHorizontal size={15} />
              {advancedAudit ? "Hide Advanced Audit" : "Advanced Audit View"}
            </button>
          </div>
        </div>

        <div className="grid gap-px bg-slate-200 md:grid-cols-3">
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Instruction Blocks</div>
            <div className="mt-2 text-2xl font-bold text-slate-950">{layers.length}</div>
            <p className="mt-1 text-xs text-slate-500">Human-authored profile layers.</p>
          </div>
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Readable Sections</div>
            <div className="mt-2 text-2xl font-bold text-emerald-700">{activeSections}</div>
            <p className="mt-1 text-xs text-slate-500">Grouped for builders instead of raw priorities.</p>
          </div>
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Runtime Additions</div>
            <div className="mt-2 text-2xl font-bold text-slate-950">Automatic</div>
            <p className="mt-1 text-xs text-slate-500">Capability, tools, memory, task, and evidence at execution.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold text-slate-900">Prompt Stack</h2>
                <p className="mt-1 text-sm text-slate-500">
                  This is the plain-English version of the layer order. The raw layer priority is still stored for audit.
                </p>
              </div>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">auditable</span>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {[
                ["1", "Base behavior", "Profile blocks attached here."],
                ["2", "Runtime context", "Capability, memory, code, and artifacts."],
                ["3", "Tools & policy", "Tool contracts and approval rules."],
                ["4", "Task + overrides", "Current request and node-level additions."],
              ].map(([step, title, copy], index) => (
                <div key={step} className="relative rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-xs font-bold text-emerald-700 shadow-sm">{step}</span>
                    <span className="font-semibold text-slate-900">{title}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{copy}</p>
                  {index < 3 && <ArrowDown size={14} className="absolute -bottom-4 left-7 hidden text-slate-300 md:block xl:hidden" />}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {groupedLayers.map(({ section, links }) => {
              const Icon = section.icon;
              const emptyRuntime = links.length === 0 && ["capability", "tools", "workflow", "runtime"].includes(section.key);
              return (
                <section key={section.key} className="card overflow-hidden">
                  <div className="flex flex-col gap-3 border-b border-slate-100 p-5 md:flex-row md:items-start md:justify-between">
                    <div className="flex gap-3">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${colorClasses(section.color)}`}>
                        <Icon size={18} />
                      </div>
                      <div>
                        <h2 className="font-semibold text-slate-900">{section.title}</h2>
                        <p className="mt-1 text-sm text-slate-500">{section.description}</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                      {links.length} block{links.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="space-y-3 p-5">
                    {emptyRuntime && (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                        {runtimeNote(section.key)}
                      </div>
                    )}

                    {links.map(link => {
                      const layer = (link.promptLayer ?? {}) as Record<string, unknown>;
                      return (
                        <div key={link.id as string} className="rounded-xl border border-slate-200 bg-white p-4">
                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-slate-900">{layer.name as string}</span>
                                {!!link.isEnabled && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                    <CheckCircle2 size={12} />
                                    enabled
                                  </span>
                                )}
                                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${colorClasses(section.color)}`}>
                                  {labelize(layer.layerType)}
                                </span>
                              </div>
                              <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-600">{layer.content as string}</p>
                            </div>
                            <div className="shrink-0 text-xs text-slate-500">
                              <span className="rounded-full bg-slate-100 px-2 py-1">{labelize(layer.scopeType)}</span>
                            </div>
                          </div>

                          {advancedAudit && (
                            <div className="mt-4 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs md:grid-cols-2">
                              <div><span className="font-semibold text-slate-700">Profile priority:</span> {Number(link.priority ?? 0)}</div>
                              <div><span className="font-semibold text-slate-700">Layer priority:</span> {Number(layer.priority ?? 0)}</div>
                              <div><span className="font-semibold text-slate-700">Layer type:</span> {String(layer.layerType ?? "unknown")}</div>
                              <div><span className="font-semibold text-slate-700">Scope type:</span> {String(layer.scopeType ?? "unknown")}</div>
                              <div className="md:col-span-2"><span className="font-semibold text-slate-700">Scope ID:</span> <code>{String(layer.scopeId || "none")}</code></div>
                              <div className="md:col-span-2"><span className="font-semibold text-slate-700">Hash:</span> <code>{shortHash(layer.contentHash)}</code></div>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {!emptyRuntime && links.length === 0 && (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                        No human-authored blocks are attached in this section yet.
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        <aside className="space-y-5">
          <div className="card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-emerald-50 p-2.5 text-emerald-700">
                <Plus size={18} />
              </div>
              <div>
                <h2 className="font-semibold text-slate-900">Add Instruction Block</h2>
                <p className="mt-1 text-sm text-slate-500">Choose the intent first. Priority is selected automatically unless audit mode is enabled.</p>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Instruction intent</label>
                <select
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                  value={selectedSectionKey}
                  onChange={e => handleSectionChange(e.target.value)}
                >
                  {SECTIONS.map(section => <option key={section.key} value={section.key}>{section.title}</option>)}
                </select>
                <p className="mt-1 text-xs text-slate-500">{selectedSection.description}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 text-sm">
                <button
                  type="button"
                  className={`rounded-lg px-3 py-2 font-semibold ${attachMode === "existing" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                  onClick={() => setAttachMode("existing")}
                >
                  Existing
                </button>
                <button
                  type="button"
                  className={`rounded-lg px-3 py-2 font-semibold ${attachMode === "new" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                  onClick={() => setAttachMode("new")}
                >
                  New Block
                </button>
              </div>

              {attachMode === "existing" ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Instruction block</label>
                    <select
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                      value={layerId}
                      onChange={e => setLayerId(e.target.value)}
                    >
                      <option value="">Pick a matching block</option>
                      {layerOptions.map(l => (
                        <option key={l.id as string} value={l.id as string}>
                          [{labelize(l.layerType)}] {l.name as string}
                        </option>
                      ))}
                    </select>
                    {layersError && <p className="mt-2 text-xs text-red-700">Layer catalog is not available right now.</p>}
                    {!layersError && layerOptions.length === 0 && (
                      <p className="mt-2 text-xs text-amber-700">No matching blocks found. Create a new one instead.</p>
                    )}
                  </div>
                  <button className="btn-primary w-full justify-center" onClick={attachExisting} disabled={!layerId}>
                    <Plus size={14} />
                    Attach Block
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Block name</label>
                    <input
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                      placeholder={`${selectedSection.title} instructions`}
                      value={newLayer.name}
                      onChange={e => setNewLayer(layer => ({ ...layer, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Instruction text</label>
                    <textarea
                      rows={7}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                      placeholder="Write the reusable instruction block..."
                      value={newLayer.content}
                      onChange={e => setNewLayer(layer => ({ ...layer, content: e.target.value }))}
                    />
                  </div>

                  {advancedAudit && (
                    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Raw layer type</label>
                        <select
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                          value={newLayer.layerType}
                          onChange={e => setNewLayer(layer => ({ ...layer, layerType: e.target.value }))}
                        >
                          {ALL_LAYER_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Raw scope type</label>
                        <select
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                          value={newLayer.scopeType}
                          onChange={e => setNewLayer(layer => ({ ...layer, scopeType: e.target.value }))}
                        >
                          {SCOPE_TYPES.map(scope => <option key={scope} value={scope}>{scope}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Scope ID</label>
                        <input
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                          placeholder="optional raw id"
                          value={newLayer.scopeId}
                          onChange={e => setNewLayer(layer => ({ ...layer, scopeId: e.target.value }))}
                        />
                      </div>
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={newLayer.isRequired}
                      onChange={e => setNewLayer(layer => ({ ...layer, isRequired: e.target.checked }))}
                    />
                    Required instruction block
                  </label>

                  <button
                    className="btn-primary w-full justify-center"
                    onClick={createAndAttach}
                    disabled={creating || !newLayer.name.trim() || !newLayer.content.trim()}
                  >
                    <Plus size={14} />
                    {creating ? "Creating..." : "Create and Attach"}
                  </button>
                </div>
              )}

              {advancedAudit && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Profile link priority</label>
                  <input
                    type="number"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                    value={manualPriority}
                    onChange={e => setManualPriority(Number(e.target.value))}
                  />
                  <p className="mt-1 text-xs text-slate-500">Normal mode uses {selectedSection.defaultPriority} for {selectedSection.title}.</p>
                </div>
              )}
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-700">
                <Layers size={18} />
              </div>
              <div>
                <h2 className="font-semibold text-slate-900">Runtime additions</h2>
                <p className="mt-1 text-sm text-slate-500">These are added during execution and visible in prompt assembly audit.</p>
              </div>
            </div>
            <div className="mt-4 space-y-3 text-sm">
              {[
                ["Capability context", "Capability metadata, knowledge artifacts, memory, and code symbols."],
                ["Tool contracts", "Allowed tools, input/output schemas, risk, and approval rules."],
                ["Task context", "The current workflow node task and any node-level override text."],
                ["Runtime evidence", "Artifacts, prior outputs, and execution-specific evidence."],
              ].map(([title, copy]) => (
                <div key={title} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="font-semibold text-slate-800">{title}</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{copy}</p>
                </div>
              ))}
            </div>
          </div>

          {advancedAudit && (
            <div className="card p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-slate-100 p-2.5 text-slate-700">
                  <LockKeyhole size={18} />
                </div>
                <div>
                  <h2 className="font-semibold text-slate-900">Raw Audit Metadata</h2>
                  <p className="mt-1 text-sm text-slate-500">Visible for platform/admin debugging.</p>
                </div>
              </div>
              <div className="mt-4 space-y-2 text-xs">
                <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-700">Profile ID:</span> <code>{p.id as string}</code></div>
                <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-700">Owner scope:</span> {String(p.ownerScopeType || "none")}</div>
                <div className="rounded-lg bg-slate-50 p-3"><span className="font-semibold text-slate-700">Owner scope ID:</span> <code>{String(p.ownerScopeId || "none")}</code></div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
