"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Copy,
  Cpu,
  FileText,
  Layers,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  XCircle,
} from "lucide-react";
import { runtimeApi } from "@/lib/api";

type Row = Record<string, unknown>;

type ModelRow = {
  id?: string;
  label?: string;
  provider?: string;
  model?: string;
  ready?: boolean;
  default?: boolean;
  supportsTools?: boolean;
  costTier?: string;
  warnings?: string[];
  maxOutputTokens?: number;
};

type CompareItem = {
  ok?: boolean;
  modelAlias?: string | null;
  error?: string;
  estimatedInputTokens?: number;
  requestedOutputTokens?: number;
  estimatedTotalTokens?: number;
  maxContextTokens?: number | null;
  budgetStatus?: string;
  warnings?: string[];
  budgetWarnings?: string[];
  promptAssemblyId?: string | null;
  traceId?: string | null;
  contextPlanHash?: string | null;
  contextPlanValid?: boolean | null;
};

const BUDGET_PRESETS = {
  Lean: {
    optimizationMode: "aggressive",
    maxContextTokens: 6000,
    maxOutputTokens: 900,
    knowledgeTopK: 4,
    memoryTopK: 3,
    codeTopK: 4,
    maxLayerChars: 9000,
    maxPromptChars: 28000,
  },
  Balanced: {
    optimizationMode: "medium",
    maxContextTokens: 12000,
    maxOutputTokens: 1500,
    knowledgeTopK: 8,
    memoryTopK: 6,
    codeTopK: 8,
    maxLayerChars: 16000,
    maxPromptChars: 56000,
  },
  Deep: {
    optimizationMode: "conservative",
    maxContextTokens: 20000,
    maxOutputTokens: 2400,
    knowledgeTopK: 12,
    memoryTopK: 10,
    codeTopK: 12,
    maxLayerChars: 28000,
    maxPromptChars: 90000,
  },
} as const;

const RISK_LEVELS = ["low", "medium", "high", "critical"];

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function asArray(value: unknown, key?: string): Row[] {
  if (Array.isArray(value)) return value as Row[];
  const record = asRecord(value);
  if (key && Array.isArray(record[key])) return record[key] as Row[];
  if (Array.isArray(record.items)) return record.items as Row[];
  if (Array.isArray(record.data)) return record.data as Row[];
  return [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function labelize(value: unknown): string {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function safeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function statusBadgeClass(status: string) {
  if (status.includes("over") || status.includes("blocked") || status.includes("error")) return "badge-critical";
  if (status.includes("may") || status.includes("warning")) return "badge-medium";
  return "badge-active";
}

function extractModels(settings: Row | undefined): ModelRow[] {
  const modelsResult = asRecord(settings?.models);
  const modelData = asRecord(modelsResult.data);
  return Array.isArray(modelData.models) ? modelData.models as ModelRow[] : [];
}

function defaultModelAliases(models: ModelRow[]): string[] {
  const defaults = models.filter(model => model.default && model.ready && model.id).map(model => model.id as string);
  if (defaults.length) return defaults.slice(0, 3);
  return models.filter(model => model.ready && model.id).map(model => model.id as string).slice(0, 3);
}

function promptText(preview: Row | null): string {
  const assembled = asRecord(preview?.assembled);
  return stringValue(assembled.systemPrompt);
}

function layerTokenRows(preview: Row | null): Row[] {
  const plan = asRecord(preview?.contextPlan);
  return asArray(plan.selectedLayers).sort((a, b) => numberValue(b.tokenEstimate, 0) - numberValue(a.tokenEstimate, 0));
}

function retrievalCounts(preview: Row | null) {
  const plan = asRecord(preview?.contextPlan);
  return {
    knowledge: asArray(plan.retrievedKnowledge).length,
    memory: asArray(plan.retrievedMemory).length,
    code: asArray(plan.retrievedCode).length,
    tools: asArray(plan.toolContracts).length,
  };
}

function buildRecommendations(preview: Row | null, compareItems: CompareItem[], form: WorkbenchForm): string[] {
  const recs: string[] = [];
  const inputTokens = numberValue(preview?.estimatedInputTokens, 0);
  const maxContext = form.maxContextTokens;
  const plan = asRecord(preview?.contextPlan);
  const missing = asArray(plan.missingRequired);
  const stats = asRecord(preview?.retrievalStats);
  const layers = layerTokenRows(preview);

  if (!preview) {
    return [
      "Run Preview first to see Composer layers, context plan, and token risk.",
      "Select at least one ready model alias before comparing options.",
    ];
  }
  if (missing.length > 0) {
    recs.push(`Fix ${missing.length} missing required context layer(s) before using fail-closed or governed delivery.`);
  }
  if (maxContext && inputTokens > maxContext * 0.85) {
    recs.push("Input is close to the context budget. Reduce retrieval top-K, lower max layer chars, or use artifact excerpts.");
  }
  if (numberValue(stats.trimmedLayers, 0) > 0) {
    recs.push("Composer trimmed layers. Inspect the largest layers and move repetitive instructions into a smaller profile block.");
  }
  if (form.maxOutputTokens > 1800 && maxContext && inputTokens + form.maxOutputTokens > maxContext) {
    recs.push("Requested output tokens may crowd out context. Lower max output tokens for planning or verification phases.");
  }
  if (layers[0]) {
    recs.push(`Largest layer is ${String(layers[0].layerType ?? "unknown")} at about ${numberValue(layers[0].tokenEstimate, 0)} tokens.`);
  }
  if (compareItems.some(item => item.ok === false)) {
    recs.push("At least one selected alias is blocked or failed preview. Remove it or fix gateway readiness before execution.");
  }
  if (!form.capabilityId) {
    recs.push("Choose a capability to let Composer include capability knowledge, memory, code symbols, and tool context.");
  }
  if (recs.length === 0) recs.push("Prompt fits the selected budget. Use a sample response only if you need model-authored output.");
  return recs;
}

type WorkbenchForm = {
  task: string;
  capabilityId: string;
  agentTemplateId: string;
  profileId: string;
  activeModelAlias: string;
  selectedModelAliases: string[];
  budgetPreset: keyof typeof BUDGET_PRESETS;
  optimizationMode: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  knowledgeTopK: number;
  memoryTopK: number;
  codeTopK: number;
  maxLayerChars: number;
  maxPromptChars: number;
  extraContext: string;
  toolDiscoveryEnabled: boolean;
  toolRiskMax: string;
  toolLimit: number;
};

const initialPreset = BUDGET_PRESETS.Balanced;

export default function PromptWorkbenchPage() {
  const [sessionId] = useState(() => safeId("prompt-workbench"));
  const [linkedProfileId, setLinkedProfileId] = useState("");
  const [form, setForm] = useState<WorkbenchForm>({
    task: "Plan the implementation work, identify required context, and produce a concise delivery prompt.",
    capabilityId: "",
    agentTemplateId: "",
    profileId: linkedProfileId,
    activeModelAlias: "",
    selectedModelAliases: [],
    budgetPreset: "Balanced",
    optimizationMode: initialPreset.optimizationMode,
    maxContextTokens: initialPreset.maxContextTokens,
    maxOutputTokens: initialPreset.maxOutputTokens,
    temperature: 0.2,
    knowledgeTopK: initialPreset.knowledgeTopK,
    memoryTopK: initialPreset.memoryTopK,
    codeTopK: initialPreset.codeTopK,
    maxLayerChars: initialPreset.maxLayerChars,
    maxPromptChars: initialPreset.maxPromptChars,
    extraContext: "",
    toolDiscoveryEnabled: true,
    toolRiskMax: "medium",
    toolLimit: 8,
  });

  useEffect(() => {
    const profileId = new URLSearchParams(window.location.search).get("profileId") ?? "";
    if (!profileId) return;
    setLinkedProfileId(profileId);
    setForm(current => ({ ...current, profileId }));
  }, []);

  const { data: capabilities } = useSWR("prompt-workbench-capabilities", () => runtimeApi.listCapabilities());
  const { data: templatesData, error: templatesError } = useSWR(
    ["prompt-workbench-templates", form.capabilityId || "all"],
    () => runtimeApi.listTemplatesScoped("all", form.capabilityId || undefined),
  );
  const { data: profiles } = useSWR("prompt-workbench-profiles", () => runtimeApi.listProfiles());
  const { data: settings, mutate: reloadSettings } = useSWR("prompt-workbench-llm-settings", () => runtimeApi.llmSettings(), { refreshInterval: 30000 });

  const [preview, setPreview] = useState<Row | null>(null);
  const [compare, setCompare] = useState<Row | null>(null);
  const [response, setResponse] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "compare" | "respond" | null>(null);

  const capabilityItems = useMemo(() => asArray(capabilities), [capabilities]);
  const templateItems = useMemo(() => asArray(templatesData, "items"), [templatesData]);
  const profileItems = useMemo(() => asArray(profiles), [profiles]);
  const models = useMemo(() => extractModels(settings), [settings]);
  const modelById = useMemo(() => new Map(models.map(model => [model.id ?? "", model])), [models]);
  const compareItems = useMemo(() => asArray(compare?.items) as CompareItem[], [compare]);
  const layerRows = useMemo(() => layerTokenRows(preview), [preview]);
  const recs = useMemo(() => buildRecommendations(preview, compareItems, form), [preview, compareItems, form]);
  const counts = retrievalCounts(preview);

  useEffect(() => {
    if (form.capabilityId || capabilityItems.length === 0) return;
    setForm(current => ({ ...current, capabilityId: stringValue(capabilityItems[0]?.id) }));
  }, [capabilityItems, form.capabilityId]);

  useEffect(() => {
    if (templateItems.length === 0) return;
    if (form.agentTemplateId && templateItems.some(item => stringValue(item.id) === form.agentTemplateId)) return;
    const match = form.profileId
      ? templateItems.find(item => stringValue(item.basePromptProfileId) === form.profileId || stringValue(item.promptProfileId) === form.profileId)
      : undefined;
    const preferred = match
      ?? templateItems.find(item => stringValue(item.capabilityId) === form.capabilityId && /architect|developer|product owner/i.test(stringValue(item.name)))
      ?? templateItems.find(item => stringValue(item.capabilityId) === form.capabilityId)
      ?? templateItems[0];
    setForm(current => ({
      ...current,
      agentTemplateId: stringValue(preferred.id),
    }));
  }, [form.agentTemplateId, form.capabilityId, form.profileId, templateItems]);

  useEffect(() => {
    if (form.selectedModelAliases.length > 0 || models.length === 0) return;
    const aliases = defaultModelAliases(models);
    setForm(current => ({
      ...current,
      selectedModelAliases: aliases,
      activeModelAlias: aliases[0] ?? "",
    }));
  }, [models, form.selectedModelAliases.length]);

  function setField<K extends keyof WorkbenchForm>(key: K, value: WorkbenchForm[K]) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function applyPreset(name: keyof typeof BUDGET_PRESETS) {
    const preset = BUDGET_PRESETS[name];
    setForm(current => ({
      ...current,
      budgetPreset: name,
      optimizationMode: preset.optimizationMode,
      maxContextTokens: preset.maxContextTokens,
      maxOutputTokens: preset.maxOutputTokens,
      knowledgeTopK: preset.knowledgeTopK,
      memoryTopK: preset.memoryTopK,
      codeTopK: preset.codeTopK,
      maxLayerChars: preset.maxLayerChars,
      maxPromptChars: preset.maxPromptChars,
    }));
  }

  function toggleAlias(alias: string) {
    setForm(current => {
      const selected = current.selectedModelAliases.includes(alias)
        ? current.selectedModelAliases.filter(item => item !== alias)
        : [...current.selectedModelAliases, alias];
      return {
        ...current,
        selectedModelAliases: selected,
        activeModelAlias: selected.includes(current.activeModelAlias) ? current.activeModelAlias : selected[0] ?? "",
      };
    });
  }

  function composePayload(modelAlias?: string): Row {
    const extraContext = form.extraContext.trim();
    return {
      agentTemplateId: form.agentTemplateId,
      capabilityId: form.capabilityId || undefined,
      task: form.task,
      workflowContext: {
        instanceId: sessionId,
        nodeId: "prompt-workbench",
        phaseId: "prompt_optimization",
        traceId: sessionId,
        vars: {
          source: "prompt-workbench",
          profileId: form.profileId || undefined,
        },
        globals: {},
        priorOutputs: {},
      },
      artifacts: [],
      overrides: {
        additionalLayers: [],
        ...(extraContext ? { extraContext } : {}),
      },
      modelOverrides: {
        ...(modelAlias ? { modelAlias } : {}),
        temperature: form.temperature,
        maxOutputTokens: form.maxOutputTokens,
      },
      contextPolicy: {
        optimizationMode: form.optimizationMode,
        maxContextTokens: form.maxContextTokens,
        compareWithRaw: true,
        knowledgeTopK: form.knowledgeTopK,
        memoryTopK: form.memoryTopK,
        codeTopK: form.codeTopK,
        maxLayerChars: form.maxLayerChars,
        maxPromptChars: form.maxPromptChars,
      },
      toolDiscovery: {
        enabled: form.toolDiscoveryEnabled,
        riskMax: form.toolRiskMax,
        limit: form.toolLimit,
      },
    };
  }

  function validateForm(): string | null {
    if (!form.agentTemplateId) return "Choose an agent template before previewing.";
    if (!form.task.trim()) return "Enter the work or story to optimize.";
    return null;
  }

  async function runPreview() {
    const validation = validateForm();
    if (validation) {
      setError(validation);
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const out = await runtimeApi.composePreview(composePayload(form.activeModelAlias));
      setPreview(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  }

  async function runCompare() {
    const validation = validateForm();
    if (validation) {
      setError(validation);
      return;
    }
    setBusy("compare");
    setError(null);
    try {
      const aliases = form.selectedModelAliases.length ? form.selectedModelAliases : [form.activeModelAlias].filter(Boolean);
      const out = await runtimeApi.comparePromptModels({ compose: composePayload(), modelAliases: aliases });
      setCompare(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Model comparison failed");
    } finally {
      setBusy(null);
    }
  }

  async function runResponse() {
    const validation = validateForm();
    if (validation) {
      setError(validation);
      return;
    }
    setBusy("respond");
    setError(null);
    try {
      const out = await runtimeApi.composeRespond(composePayload(form.activeModelAlias));
      setResponse(out);
      setPreview(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sample response failed");
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    const text = promptText(preview);
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  const previewTokens = numberValue(preview?.estimatedInputTokens, 0);
  const responseUsage = asRecord(response?.modelUsage);
  const responseOptimization = asRecord(response?.optimization);

  return (
    <div className="space-y-6">
      <section className="section-card overflow-hidden">
        <div className="border-b border-slate-200 bg-gradient-to-br from-white via-emerald-50/40 to-slate-50 p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-4xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
                <WandSparkles size={14} />
                Prompt Workbench
              </div>
              <h1 className="mt-4 text-3xl font-bold text-slate-950">Plan prompts, compare models, and estimate token needs</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Compose the same governed prompt stack used by runtime agents, inspect the Context Plan, compare approved model aliases, and run a controlled sample response only when needed.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary bg-white" onClick={() => void reloadSettings()}>
                <RefreshCw size={15} />
                Refresh models
              </button>
              <button className="btn-primary" onClick={() => void runPreview()} disabled={busy !== null}>
                <Sparkles size={15} />
                {busy === "preview" ? "Previewing..." : "Run Preview"}
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-px bg-slate-200 md:grid-cols-4">
          <SummaryTile icon={FileText} label="Input tokens" value={preview ? String(previewTokens) : "not previewed"} />
          <SummaryTile icon={Layers} label="Prompt layers" value={preview ? String(layerRows.length) : "-"} />
          <SummaryTile icon={Cpu} label="Models selected" value={String(form.selectedModelAliases.length || 0)} />
          <SummaryTile icon={ShieldCheck} label="Context plan" value={preview ? String(asRecord(preview.contextPlan).valid ?? "unknown") : "pending"} />
        </div>
      </section>

      {error && (
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div>{error}</div>
          </div>
        </div>
      )}

      <div className="grid gap-6 2xl:grid-cols-[360px_minmax(0,1fr)_360px]">
        <aside className="space-y-4">
          <WorkbenchPanel title="Work setup" icon={Bot}>
            <Field label="Capability">
              <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.capabilityId} onChange={e => setField("capabilityId", e.target.value)}>
                <option value="">No capability context</option>
                {capabilityItems.map(cap => (
                  <option key={stringValue(cap.id)} value={stringValue(cap.id)}>
                    {stringValue(cap.name, stringValue(cap.id))} {cap.capabilityType ? `- ${cap.capabilityType}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent template">
              <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.agentTemplateId} onChange={e => setField("agentTemplateId", e.target.value)}>
                <option value="">Select agent template</option>
                {templateItems.map(template => (
                  <option key={stringValue(template.id)} value={stringValue(template.id)}>
                    {stringValue(template.name, stringValue(template.id))}
                    {template.scope ? ` - ${String(template.scope)}` : ""}
                  </option>
                ))}
              </select>
              {templatesError ? (
                <p className="mt-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                  Could not load agent templates: {templatesError instanceof Error ? templatesError.message : "unknown error"}
                </p>
              ) : templateItems.length === 0 ? (
                <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  No active templates were returned for this capability. Bootstrap or activate a capability agent first.
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Showing capability-specific agents first, plus common locked templates for fallback.
                </p>
              )}
            </Field>
            <Field label="Behavior profile reference">
              <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.profileId} onChange={e => setField("profileId", e.target.value)}>
                <option value="">Use template default</option>
                {profileItems.map(profile => (
                  <option key={stringValue(profile.id)} value={stringValue(profile.id)}>
                    {stringValue(profile.name, stringValue(profile.id))}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">Prompt Composer still uses the selected agent template as the executable source.</p>
            </Field>
            <Field label="Work / story">
              <textarea
                className="min-h-[150px] w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6"
                value={form.task}
                maxLength={4000}
                onChange={e => setField("task", e.target.value)}
              />
              <div className="mt-1 text-right text-xs text-slate-400">{form.task.length}/4000</div>
            </Field>
            <Field label="Extra context">
              <textarea
                className="min-h-[90px] w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6"
                placeholder="Optional constraints, stakeholder decisions, acceptance notes."
                value={form.extraContext}
                maxLength={4000}
                onChange={e => setField("extraContext", e.target.value)}
              />
            </Field>
          </WorkbenchPanel>

          <WorkbenchPanel title="Budget and context knobs" icon={BarChart3}>
            <Field label="Budget preset">
              <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-100 p-1">
                {(Object.keys(BUDGET_PRESETS) as Array<keyof typeof BUDGET_PRESETS>).map(name => (
                  <button
                    key={name}
                    type="button"
                    className={`rounded-lg px-2 py-2 text-xs font-semibold ${form.budgetPreset === name ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}
                    onClick={() => applyPreset(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Max input" value={form.maxContextTokens} min={2000} step={500} onChange={v => setField("maxContextTokens", v)} />
              <NumberField label="Max output" value={form.maxOutputTokens} min={100} step={100} onChange={v => setField("maxOutputTokens", v)} />
              <NumberField label="Knowledge top-K" value={form.knowledgeTopK} min={0} max={50} onChange={v => setField("knowledgeTopK", v)} />
              <NumberField label="Memory top-K" value={form.memoryTopK} min={0} max={50} onChange={v => setField("memoryTopK", v)} />
              <NumberField label="Code top-K" value={form.codeTopK} min={0} max={50} onChange={v => setField("codeTopK", v)} />
              <NumberField label="Tool limit" value={form.toolLimit} min={0} max={50} onChange={v => setField("toolLimit", v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Max layer chars" value={form.maxLayerChars} min={500} step={500} onChange={v => setField("maxLayerChars", v)} />
              <NumberField label="Max prompt chars" value={form.maxPromptChars} min={2000} step={1000} onChange={v => setField("maxPromptChars", v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode">
                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.optimizationMode} onChange={e => setField("optimizationMode", e.target.value)}>
                  <option value="aggressive">aggressive</option>
                  <option value="medium">medium</option>
                  <option value="conservative">conservative</option>
                </select>
              </Field>
              <NumberField label="Temperature" value={form.temperature} min={0} max={2} step={0.1} onChange={v => setField("temperature", v)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tool risk max">
                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.toolRiskMax} onChange={e => setField("toolRiskMax", e.target.value)}>
                  {RISK_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
                </select>
              </Field>
              <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={form.toolDiscoveryEnabled} onChange={e => setField("toolDiscoveryEnabled", e.target.checked)} />
                Tool discovery
              </label>
            </div>
          </WorkbenchPanel>
        </aside>

        <main className="space-y-4">
          <WorkbenchPanel title="Composed prompt preview" icon={Layers} actions={(
            <div className="flex flex-wrap gap-2">
              {preview?.promptAssemblyId ? (
                <Link className="btn-secondary bg-white" href={`/prompt-assemblies/${encodeURIComponent(String(preview.promptAssemblyId))}`}>
                  Open Assembly
                </Link>
              ) : null}
              <button className="btn-secondary bg-white" onClick={() => void copyPrompt()} disabled={!promptText(preview)}>
                <Copy size={14} />
                Copy prompt
              </button>
            </div>
          )}>
            {!preview ? (
              <EmptyState title="No preview yet" copy="Run Preview to assemble the same layered prompt stack used by runtime agents." />
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <Metric label="Input tokens" value={String(previewTokens)} />
                  <Metric label="Knowledge" value={String(counts.knowledge)} />
                  <Metric label="Memory" value={String(counts.memory)} />
                  <Metric label="Code symbols" value={String(counts.code)} />
                </div>
                <pre className="max-h-[420px] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                  {promptText(preview) || "Composer did not return a system prompt preview."}
                </pre>
              </div>
            )}
          </WorkbenchPanel>

          <div className="grid gap-4 xl:grid-cols-2">
            <WorkbenchPanel title="Layer token breakdown" icon={FileText}>
              {layerRows.length === 0 ? (
                <EmptyState title="Layer data pending" copy="Preview will show the largest prompt layers and required-context status." compact />
              ) : (
                <div className="space-y-2">
                  {layerRows.slice(0, 8).map((layer, index) => (
                    <div key={`${String(layer.layerHash)}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{String(layer.promptLayerName ?? layer.layerType ?? "Layer")}</div>
                          <div className="mt-1 text-xs text-slate-500">{String(layer.layerType ?? "UNKNOWN")} - {String(layer.inclusionReason ?? "included")}</div>
                        </div>
                        <span className="rounded-full bg-white px-2 py-1 font-mono text-xs text-slate-700">{numberValue(layer.tokenEstimate, 0)} tok</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </WorkbenchPanel>

            <WorkbenchPanel title="Context plan and warnings" icon={ShieldCheck}>
              {preview ? (
                <div className="space-y-3">
                  <div className={`rounded-xl border p-3 ${asRecord(preview.contextPlan).valid ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                    <div className="flex items-center gap-2 font-semibold">
                      {asRecord(preview.contextPlan).valid ? <CheckCircle2 size={16} className="text-emerald-700" /> : <AlertTriangle size={16} className="text-amber-700" />}
                      Context Plan: {String(asRecord(preview.contextPlan).valid ?? "unknown")}
                    </div>
                    <div className="mt-1 font-mono text-xs text-slate-500">{String(asRecord(preview.contextPlan).contextPlanHash ?? "hash not returned")}</div>
                  </div>
                  {[...asArray(preview.warnings), ...asArray(preview.budgetWarnings)].length > 0 ? (
                    <ul className="space-y-2 text-sm text-amber-800">
                      {[...asArray(preview.warnings), ...asArray(preview.budgetWarnings)].map((warning, index) => (
                        <li key={index} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">{String(warning)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">No Composer warnings returned.</p>
                  )}
                </div>
              ) : (
                <EmptyState title="Context plan pending" copy="Required layers, missing context, and budget decisions appear after preview." compact />
              )}
            </WorkbenchPanel>
          </div>

          <WorkbenchPanel title="Sample response" icon={MessageSquare} actions={(
            <button className="btn-primary" onClick={() => void runResponse()} disabled={busy !== null}>
              <Send size={14} />
              {busy === "respond" ? "Running..." : "Run sample response"}
            </button>
          )}>
            {!response ? (
              <EmptyState title="No model response yet" copy="This is intentionally manual. Click Run sample response only when you want a governed LLM call." compact />
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-800 whitespace-pre-wrap">
                  {String(response.response ?? "No response text returned.")}
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <Metric label="Model alias" value={String(responseUsage.modelAlias ?? form.activeModelAlias ?? "-")} />
                  <Metric label="Provider/model" value={`${String(responseUsage.provider ?? "-")} / ${String(responseUsage.model ?? "-")}`} />
                  <Metric label="Total tokens" value={String(responseUsage.total_tokens ?? "-")} />
                  <Metric label="Cost" value={responseUsage.estimated_cost != null ? String(responseUsage.estimated_cost) : "UNPRICED"} />
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                  <div><b>Prompt Assembly:</b> {String(response.promptAssemblyId ?? "-")}</div>
                  <div><b>Model Call:</b> {String(response.modelCallId ?? "-")}</div>
                  <div><b>Tokens saved:</b> {String(responseOptimization.tokens_saved ?? 0)}</div>
                </div>
              </div>
            )}
          </WorkbenchPanel>
        </main>

        <aside className="space-y-4">
          <WorkbenchPanel title="Model aliases" icon={Cpu} actions={(
            <button className="btn-secondary bg-white" onClick={() => void runCompare()} disabled={busy !== null}>
              <Play size={14} />
              {busy === "compare" ? "Comparing..." : "Compare"}
            </button>
          )}>
            <div className="space-y-2">
              {models.length === 0 && <EmptyState title="No model catalog" copy="Gateway did not return model aliases. Check LLM Settings." compact />}
              {models.map(model => {
                const alias = model.id ?? "";
                const selected = form.selectedModelAliases.includes(alias);
                return (
                  <button
                    key={alias || `${model.provider}-${model.model}`}
                    type="button"
                    className={`w-full rounded-xl border p-3 text-left transition ${selected ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:border-emerald-200"}`}
                    onClick={() => alias && toggleAlias(alias)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">{model.label ?? alias}</div>
                        <div className="mt-1 font-mono text-xs text-slate-500">{alias}</div>
                      </div>
                      {model.ready ? <CheckCircle2 size={16} className="text-emerald-700" /> : <XCircle size={16} className="text-red-600" />}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{model.provider ?? "provider"}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{model.costTier ?? "UNPRICED"}</span>
                      {model.supportsTools && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700">tools</span>}
                      {model.default && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">default</span>}
                    </div>
                  </button>
                );
              })}
            </div>
            <Field label="Active response alias">
              <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={form.activeModelAlias} onChange={e => setField("activeModelAlias", e.target.value)}>
                <option value="">Use gateway default</option>
                {form.selectedModelAliases.map(alias => <option key={alias} value={alias}>{alias}</option>)}
              </select>
            </Field>
          </WorkbenchPanel>

          <WorkbenchPanel title="Model comparison" icon={BarChart3}>
            {compareItems.length === 0 ? (
              <EmptyState title="Comparison pending" copy="Select aliases and click Compare to estimate token fit per model alias." compact />
            ) : (
              <div className="space-y-2">
                {compareItems.map((item, index) => {
                  const model = item.modelAlias ? modelById.get(item.modelAlias) : undefined;
                  return (
                    <div key={`${item.modelAlias ?? "default"}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-slate-900">{model?.label ?? item.modelAlias ?? "Gateway default"}</div>
                          <div className="mt-1 font-mono text-xs text-slate-500">{item.modelAlias ?? "default alias"}</div>
                        </div>
                        <span className={`badge ${item.ok ? statusBadgeClass(item.budgetStatus ?? "fits") : "badge-critical"}`}>
                          {item.ok ? labelize(item.budgetStatus ?? "fits") : "failed"}
                        </span>
                      </div>
                      {item.ok ? (
                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                          <Metric label="Input" value={String(item.estimatedInputTokens ?? 0)} compact />
                          <Metric label="Output" value={String(item.requestedOutputTokens ?? 0)} compact />
                          <Metric label="Total" value={String(item.estimatedTotalTokens ?? 0)} compact />
                        </div>
                      ) : (
                        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{item.error ?? "Preview failed."}</p>
                      )}
                      <div className="mt-3 text-xs text-slate-500">Cost: {model?.costTier ? `${model.costTier} tier` : "UNPRICED"}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </WorkbenchPanel>

          <WorkbenchPanel title="Optimization guidance" icon={Sparkles}>
            <ul className="space-y-2 text-sm">
              {recs.map((rec, index) => (
                <li key={index} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 leading-5 text-slate-700">{rec}</li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className="btn-secondary bg-white" href="/prompt-layers">Create Instruction Block</Link>
              <Link className="btn-secondary bg-white" href="/prompt-profiles">Behavior Profiles</Link>
            </div>
          </WorkbenchPanel>
        </aside>
      </div>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="bg-white p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <Icon size={14} />
        {label}
      </div>
      <div className="mt-2 truncate text-xl font-bold text-slate-950">{value}</div>
    </div>
  );
}

function WorkbenchPanel({
  title,
  icon: Icon,
  children,
  actions,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700"><Icon size={16} /></div>
          <h2 className="font-semibold text-slate-950">{title}</h2>
        </div>
        {actions}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={e => onChange(numberValue(e.target.value, value))}
      />
    </Field>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white ${compact ? "p-2" : "p-3"}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`${compact ? "text-sm" : "text-lg"} mt-1 truncate font-bold text-slate-950`}>{value}</div>
    </div>
  );
}

function EmptyState({ title, copy, compact = false }: { title: string; copy: string; compact?: boolean }) {
  return (
    <div className={`rounded-xl border border-dashed border-slate-200 bg-slate-50 text-center ${compact ? "p-5" : "p-10"}`}>
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-400">
        <Sparkles size={18} />
      </div>
      <h3 className="mt-3 font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-slate-500">{copy}</p>
    </div>
  );
}
