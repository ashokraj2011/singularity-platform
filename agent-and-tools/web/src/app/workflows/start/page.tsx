"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Loader2,
  RadioTower,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { shortId } from "@/lib/workgraph";
import { isWorkbenchProfile, workbenchNeoUrl } from "@/lib/workbenchLaunch";
import { asBoolean, asRow, asRowArray, asString, asStringArray } from "@/lib/row";
import { Stepper, StatusChip, type Step } from "@/components/ui/primitives";

type Capability = { id: string; name?: string; capabilityType?: string | null; status?: string | null };
type GalleryItem = {
  id: string;
  label: string;
  description: string;
  requiredInputs?: string[];
  sampleStory?: string;
  defaultAgents?: string[];
  defaultModelAlias?: string;
  runtimePreference?: string;
  governancePreset?: string;
  runtimeRequirement?: string;
  templateCount?: number;
  workflowTemplate?: { id?: string; name?: string; workflowTypeKey?: string; profile?: string | null } | null;
};
type AdoptionHealth = {
  score?: number;
  summary?: {
    connectedRuntimeCount?: number;
    readyProviderCount?: number;
    readyModelAliasCount?: number;
    readyModelAliases?: string[];
    defaultModelAlias?: string | null;
    defaultModelReady?: boolean;
    seededIntentCount?: number;
  };
  blocked?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
  warning?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
};
type StartBlocker = { id: string; label: string; message: string; severity: "blocked" | "warning"; fixCommand?: string; fixRoute?: string };
type StartRecommendation = {
  intent: string;
  intentLabel: string;
  capabilityId: string | null;
  capabilityName: string | null;
  workflowTemplateId: string | null;
  workflowTemplateName: string | null;
  modelAlias: string;
  runtimePreference: string;
  governancePreset: string;
  demoMode: boolean;
};
type StartPreview = {
  story: string;
  recommendation: StartRecommendation;
  intents: GalleryItem[];
  capabilities: Capability[];
  blockers: StartBlocker[];
  warnings: StartBlocker[];
  health?: AdoptionHealth;
  catalog?: { referenceOnly?: boolean; authRequired?: boolean; message?: string | null };
};
type LaunchResult = {
  runUrl?: string | null;
  workItems?: Array<{ id: string; workCode: string }>;
  failedWorkItems?: Array<{ title: string; error: string }>;
  workflowTemplate?: { id?: string; name?: string; profile?: string | null } | null;
  workflowInstance?: { id?: string; status?: string } | null;
  warnings?: string[];
};

type PrereqCheck = { label: string; ok: boolean; optional?: boolean };

const fallbackStory = "As a platform team, I want a governed agentic SDLC workflow that turns a story into WorkItems, runs implementation, captures tests, and exports delivery evidence.";
const blockerSeverities = new Set<StartBlocker["severity"]>(["blocked", "warning"]);

function nullableString(value: unknown): string | null {
  return asString(value) || null;
}

function optionalString(value: unknown): string | undefined {
  return asString(value) || undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWorkflowTemplate(value: unknown): GalleryItem["workflowTemplate"] {
  const row = asRow(value);
  if (Object.keys(row).length === 0) return null;
  return {
    id: optionalString(row.id),
    name: optionalString(row.name),
    workflowTypeKey: optionalString(row.workflowTypeKey),
    profile: nullableString(row.profile),
  };
}

function normalizeGalleryItem(value: unknown, index: number): GalleryItem {
  const row = asRow(value);
  return {
    id: asString(row.id, `intent-${index}`),
    label: asString(row.label, `Intent ${index + 1}`),
    description: asString(row.description, "Guided SDLC workflow."),
    requiredInputs: asStringArray(row.requiredInputs),
    sampleStory: optionalString(row.sampleStory),
    defaultAgents: asStringArray(row.defaultAgents),
    defaultModelAlias: optionalString(row.defaultModelAlias),
    runtimePreference: optionalString(row.runtimePreference),
    governancePreset: optionalString(row.governancePreset),
    runtimeRequirement: optionalString(row.runtimeRequirement),
    templateCount: asNumber(row.templateCount),
    workflowTemplate: normalizeWorkflowTemplate(row.workflowTemplate),
  };
}

function normalizeCapability(value: unknown, index: number): Capability {
  const row = asRow(value);
  return {
    id: asString(row.id, `capability-${index}`),
    name: optionalString(row.name),
    capabilityType: nullableString(row.capabilityType),
    status: nullableString(row.status),
  };
}

function normalizeHealthIssue(value: unknown, index: number): { id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string } {
  const row = asRow(value);
  return {
    id: asString(row.id, `health-${index}`),
    label: asString(row.label, "Health check"),
    summary: asString(row.summary, "Check needs attention."),
    ...(optionalString(row.fixCommand) ? { fixCommand: optionalString(row.fixCommand) } : {}),
    ...(optionalString(row.fixRoute) ? { fixRoute: optionalString(row.fixRoute) } : {}),
  };
}

function normalizeAdoptionHealth(value: unknown): AdoptionHealth {
  const row = asRow(value);
  const summary = asRow(row.summary);
  return {
    score: asNumber(row.score),
    summary: {
      connectedRuntimeCount: asNumber(summary.connectedRuntimeCount),
      readyProviderCount: asNumber(summary.readyProviderCount),
      readyModelAliasCount: asNumber(summary.readyModelAliasCount),
      readyModelAliases: asStringArray(summary.readyModelAliases),
      defaultModelAlias: nullableString(summary.defaultModelAlias),
      defaultModelReady: asBoolean(summary.defaultModelReady),
      seededIntentCount: asNumber(summary.seededIntentCount),
    },
    blocked: asRowArray(row.blocked).map(normalizeHealthIssue),
    warning: asRowArray(row.warning).map(normalizeHealthIssue),
  };
}

function normalizeBlocker(value: unknown, index: number): StartBlocker {
  const row = asRow(value);
  const severity = asString(row.severity);
  return {
    id: asString(row.id, `blocker-${index}`),
    label: asString(row.label, "Prerequisite"),
    message: asString(row.message, "Setup check needs attention."),
    severity: blockerSeverities.has(severity as StartBlocker["severity"]) ? severity as StartBlocker["severity"] : "warning",
    ...(optionalString(row.fixCommand) ? { fixCommand: optionalString(row.fixCommand) } : {}),
    ...(optionalString(row.fixRoute) ? { fixRoute: optionalString(row.fixRoute) } : {}),
  };
}

function normalizeRecommendation(value: unknown): StartRecommendation {
  const row = asRow(value);
  return {
    intent: asString(row.intent, "build_feature"),
    intentLabel: asString(row.intentLabel, "Build Feature"),
    capabilityId: nullableString(row.capabilityId),
    capabilityName: nullableString(row.capabilityName),
    workflowTemplateId: nullableString(row.workflowTemplateId),
    workflowTemplateName: nullableString(row.workflowTemplateName),
    modelAlias: asString(row.modelAlias, "mock"),
    runtimePreference: asString(row.runtimePreference, "mock_ok"),
    governancePreset: asString(row.governancePreset, "standard"),
    demoMode: asBoolean(row.demoMode),
  };
}

function normalizeStartPreview(value: unknown, fallbackStoryText: string): StartPreview {
  const row = asRow(value);
  const catalog = asRow(row.catalog);
  const normalizedBlockers = asRowArray(row.blockers).map(normalizeBlocker);
  const normalizedWarnings = asRowArray(row.warnings).map(normalizeBlocker);
  return {
    story: asString(row.story, fallbackStoryText),
    recommendation: normalizeRecommendation(row.recommendation),
    intents: asRowArray(row.intents).map(normalizeGalleryItem),
    capabilities: asRowArray(row.capabilities).map(normalizeCapability),
    blockers: normalizedBlockers,
    warnings: normalizedWarnings.length
      ? normalizedWarnings
      : normalizedBlockers.filter((blocker) => blocker.severity === "warning"),
    health: normalizeAdoptionHealth(row.health),
    catalog: {
      referenceOnly: asBoolean(catalog.referenceOnly),
      authRequired: asBoolean(catalog.authRequired),
      message: nullableString(catalog.message),
    },
  };
}

function normalizeLaunchResult(value: unknown): LaunchResult {
  const row = asRow(value);
  const workflowTemplate = normalizeWorkflowTemplate(row.workflowTemplate);
  const workflowInstance = asRow(row.workflowInstance);
  return {
    runUrl: nullableString(row.runUrl),
    workItems: asRowArray(row.workItems).map((item) => ({
      id: asString(item.id),
      workCode: asString(item.workCode),
    })),
    failedWorkItems: asRowArray(row.failedWorkItems).map((item) => ({
      title: asString(item.title, "WorkItem"),
      error: asString(item.error, "Creation failed"),
    })),
    workflowTemplate,
    workflowInstance: Object.keys(workflowInstance).length > 0
      ? {
        id: optionalString(workflowInstance.id),
        status: optionalString(workflowInstance.status),
      }
      : null,
    warnings: asStringArray(row.warnings),
  };
}

export default function WorkflowStartPage() {
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [intentId, setIntentId] = useState("build_feature");
  const [capabilityId, setCapabilityId] = useState("");
  const [story, setStory] = useState(fallbackStory);
  const [modelAlias, setModelAlias] = useState("balanced");
  const [runtimePreference, setRuntimePreference] = useState("user_runtime");
  const [governancePreset, setGovernancePreset] = useState("standard");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  const intents = preview?.intents ?? [];
  const capabilities = preview?.capabilities ?? [];
  const health = preview?.health;
  const referenceOnlyGallery = Boolean(preview?.catalog?.referenceOnly);
  const blockers = preview?.blockers ?? [];
  const blockingIssues = blockers.filter((blocker) => blocker.severity === "blocked");
  const warningIssues = preview?.warnings?.length ? preview.warnings : blockers.filter((blocker) => blocker.severity === "warning");
  const selectedIntent = useMemo(() => intents.find((item) => item.id === intentId) ?? intents[0] ?? null, [intentId, intents]);
  const selectedCapability = capabilities.find((capability) => capability.id === capabilityId) ?? null;
  const runtimeConnected = (health?.summary?.connectedRuntimeCount ?? 0) > 0;
  const readyModelAliases = health?.summary?.readyModelAliases ?? [];
  const selectedModelReady = modelAlias === "mock" || readyModelAliases.includes(modelAlias);
  const llmReady = selectedModelReady || (modelAlias === (health?.summary?.defaultModelAlias ?? "") && health?.summary?.defaultModelReady === true);
  const requiresRuntime = runtimePreference !== "mock_ok" && selectedIntent?.runtimePreference !== "mock_ok";
  const requiresRealModel = modelAlias !== "mock";
  const hasTemplate = Boolean(selectedIntent?.workflowTemplate?.id);
  const canLaunch = Boolean(capabilityId && story.trim().length >= 8 && hasTemplate && (!requiresRuntime || runtimeConnected) && (!requiresRealModel || llmReady) && blockingIssues.length === 0 && !launching && !loadingPreview);
  const prereqChecks: PrereqCheck[] = [
    { label: "Capability selected", ok: Boolean(capabilityId) },
    { label: "Story written", ok: story.trim().length >= 8 },
    { label: "Workflow template seeded", ok: hasTemplate },
    {
      label: requiresRuntime ? "Runtime connected" : "Runtime (mock OK)",
      ok: !requiresRuntime || runtimeConnected,
      optional: !requiresRuntime,
    },
    { label: requiresRealModel ? "LLM provider ready" : "LLM provider (mock OK)", ok: !requiresRealModel || llmReady, optional: !requiresRealModel },
  ];
  const launched = Boolean(result?.workflowInstance?.id);
  // Happy-path stage completion → drives the Stepper. The first incomplete
  // stage is "current"; everything after it is "todo".
  const stageDone = [
    Boolean(selectedIntent),
    Boolean(capabilityId),
    story.trim().length >= 8,
    prereqChecks.every((check) => check.ok || check.optional),
    launched,
  ];
  const firstIncomplete = stageDone.findIndex((done) => !done);
  const sdlcSteps: Step[] = ["Pick intent", "Choose capability", "Write story", "Prerequisites", "Launch"].map((label, index) => ({
    label,
    status: stageDone[index] ? "done" : index === firstIncomplete ? "current" : "todo",
  }));
  const resultWorkbenchUrl = result?.workflowInstance?.id && isWorkbenchProfile(result.workflowTemplate?.profile)
    ? workbenchNeoUrl({
        workflowInstanceId: result.workflowInstance.id,
        browserRunId: result.workflowInstance.id,
        goal: story.trim() || fallbackStory,
        capabilityId,
      })
    : null;

  async function loadPreview(next: Partial<{ story: string; intent: string; capabilityId: string; modelAlias: string; runtimePreference: string; governancePreset: string }> = {}) {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await fetch(apiPath("/api/start/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        cache: "no-store",
        body: JSON.stringify({
          story: next.story ?? story,
          intent: next.intent ?? intentId,
          capabilityId: next.capabilityId ?? capabilityId,
          modelAlias: next.modelAlias ?? modelAlias,
          runtimePreference: next.runtimePreference ?? runtimePreference,
          governancePreset: next.governancePreset ?? governancePreset,
        }),
      });
      const { raw, parsed, parseError } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      assertValidApiResponse("/api/start/preview", raw, parseError);
      const data = normalizeStartPreview(parsed, next.story ?? story);
      setPreview(data);
      setStory(data.story || next.story || story);
      setIntentId(data.recommendation.intent || next.intent || intentId);
      setCapabilityId(data.recommendation.capabilityId ?? next.capabilityId ?? "");
      setModelAlias(data.recommendation.modelAlias || next.modelAlias || "mock");
      setRuntimePreference(data.recommendation.runtimePreference || next.runtimePreference || "mock_ok");
      setGovernancePreset(data.recommendation.governancePreset || next.governancePreset || "standard");
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not load launch preview.");
    } finally {
      setLoadingPreview(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedIntent = params.get("intent") || undefined;
    if (requestedIntent) setIntentId(requestedIntent);
    void loadPreview({ intent: requestedIntent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyIntent(item: GalleryItem) {
    const nextStory = item.sampleStory || fallbackStory;
    setIntentId(item.id);
    setStory(nextStory);
    setModelAlias(item.defaultModelAlias || "balanced");
    setRuntimePreference(item.runtimePreference || "user_runtime");
    setGovernancePreset(item.governancePreset || "standard");
    setResult(null);
    setError(null);
    void loadPreview({
      intent: item.id,
      story: nextStory,
      modelAlias: item.defaultModelAlias,
      runtimePreference: item.runtimePreference,
      governancePreset: item.governancePreset,
    });
  }

  async function launch() {
    if (!selectedIntent) return;
    setLaunching(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(apiPath("/api/start/launch"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          capabilityId,
          intent: selectedIntent.id,
          story,
          workflowTemplateId: selectedIntent.workflowTemplate?.id,
          modelAlias,
          runtimePreference,
          governancePreset,
        }),
      });
      const { raw, parsed, parseError } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      assertValidApiResponse("/api/start/launch", raw, parseError);
      setResult(normalizeLaunchResult(parsed));
      void loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div style={{ maxWidth: 1320 }}>
      <section className="page-hero" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent-workflow)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <Rocket size={15} />
              Guided SDLC Launcher
            </div>
            <h1 className="page-header" style={{ marginBottom: 8, fontSize: 34 }}>Start Governed SDLC Work</h1>
            <p style={{ margin: 0, maxWidth: 850, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              Choose the delivery intent, paste a story, validate runtime prerequisites, then create WorkItems and launch the matching workflow.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/workflows/planner" className="btn-secondary"><ClipboardList size={15} /> Story planner</Link>
            <Link href="/llm-settings" className="btn-secondary"><RadioTower size={15} /> Runtime setup</Link>
            <Link href="/operations/readiness" className="btn-secondary"><ShieldCheck size={15} /> Health</Link>
          </div>
        </div>
      </section>

      <section className="data-panel" style={{ padding: "13px 18px", marginBottom: 16 }}>
        <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 9 }}>Happy path</div>
        <Stepper steps={sdlcSteps} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric icon={ShieldCheck} label="Adoption score" value={health?.score != null ? `${health.score}%` : "..."} tone={(health?.score ?? 0) >= 80 ? "#047857" : "#b45309"} />
        <Metric icon={RadioTower} label="Runtime bridge" value={runtimeConnected ? "Connected" : "Waiting"} tone={runtimeConnected ? "#047857" : "#b45309"} />
        <Metric icon={Sparkles} label="Model aliases" value={`${health?.summary?.readyModelAliasCount ?? 0} ready`} tone={llmReady ? "#047857" : "#b45309"} />
        <Metric icon={GitBranch} label="Seeded intents" value={`${health?.summary?.seededIntentCount ?? 0}/${intents.length || 0}`} tone={hasTemplate ? "#047857" : "#b45309"} />
      </section>

      {previewError && (
        <section className="data-panel" style={{ padding: 14, borderColor: "#fde68a", background: "#fffbeb", color: "#92400e", marginBottom: 16 }}>
          {previewError}
        </section>
      )}

      {referenceOnlyGallery && (
        <section className="data-panel" style={{ padding: 14, borderColor: "#fde68a", background: "#fffbeb", color: "#92400e", marginBottom: 16 }}>
          {preview?.catalog?.message ?? "Login is required to inspect saved workflow templates. Showing the built-in SDLC intent catalog."}
        </section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 0.85fr) minmax(0, 1.15fr)", gap: 16, alignItems: "start" }}>
        <section className="data-panel" style={{ display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Intent</h2>
          {intents.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => applyIntent(item)}
              className="card-hover"
              style={{
                textAlign: "left",
                border: item.id === intentId ? "1px solid rgba(37,99,235,0.42)" : "1px solid var(--color-outline-variant)",
                background: item.id === intentId ? "var(--accent-workflow-soft)" : "#fff",
                borderRadius: 8,
                padding: 13,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <strong>{item.label}</strong>
                <span className={item.workflowTemplate?.id ? "badge badge-active" : "badge badge-pending_approval"}>
                  {item.workflowTemplate?.id ? "seeded" : referenceOnlyGallery ? "login required" : "missing"}
                </span>
              </div>
              <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>{item.description}</p>
            </button>
          ))}
          {intents.length === 0 && <Empty text="Template gallery has not loaded yet." />}
        </section>

        <section className="data-panel" style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{selectedIntent?.label ?? "Launch details"}</h2>
              <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 13 }}>{selectedIntent?.runtimeRequirement ?? "Select an intent to see runtime requirements."}</p>
            </div>
            <span className="badge badge-pending_approval">DRAFT launch</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
            <Field label="Capability">
              <select
                value={capabilityId}
                onChange={(event) => {
                  const nextCapabilityId = event.target.value;
                  setCapabilityId(nextCapabilityId);
                  setResult(null);
                  void loadPreview({ capabilityId: nextCapabilityId });
                }}
                style={inputStyle()}
              >
                <option value="">Select capability</option>
                {capabilities.map((capability) => <option key={capability.id} value={capability.id}>{capability.name ?? capability.id}</option>)}
              </select>
            </Field>
            <Field label="Workflow template">
              <input value={selectedIntent?.workflowTemplate?.name ?? "No matching seed"} readOnly style={inputStyle({ color: hasTemplate ? "var(--color-on-surface)" : "#92400e" })} />
            </Field>
          </div>

          {selectedCapability && (
            <div style={{ color: "var(--color-outline)", fontSize: 12 }}>
              Selected capability: <strong style={{ color: "var(--color-on-surface)" }}>{selectedCapability.name ?? selectedCapability.id}</strong> · {shortId(selectedCapability.id)}
            </div>
          )}

          <Field label="Story / work request">
            <textarea value={story} onChange={(event) => setStory(event.target.value)} rows={8} style={inputStyle({ resize: "vertical", lineHeight: 1.5 })} />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Field label="Model alias">
              <input value={modelAlias} onChange={(event) => setModelAlias(event.target.value)} style={inputStyle()} />
            </Field>
            <Field label="Runtime preference">
              <select value={runtimePreference} onChange={(event) => setRuntimePreference(event.target.value)} style={inputStyle()}>
                <option value="user_runtime">User runtime</option>
                <option value="tenant_runtime">Tenant runtime</option>
                <option value="mock_ok">Mock allowed</option>
              </select>
            </Field>
            <Field label="Governance preset">
              <select value={governancePreset} onChange={(event) => setGovernancePreset(event.target.value)} style={inputStyle()}>
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
                <option value="evidence_first">Evidence first</option>
              </select>
            </Field>
          </div>

          {loadingPreview && (
            <Panel tone="#2563eb" icon={Loader2} title="Refreshing launch preview" body="Checking capability, workflow template, runtime, and model readiness." />
          )}
          <Prerequisites checks={prereqChecks} blockers={blockingIssues} warnings={warningIssues} />
          {!llmReady && requiresRealModel && (
            <Panel
              tone="#b91c1c"
              icon={AlertTriangle}
              title="Selected model alias is not ready"
              body={`${modelAlias || "Model alias"} is not in the ready alias set reported by Runtime & Models. Choose one of: ${readyModelAliases.slice(0, 6).join(", ") || "no ready aliases reported"}.`}
              actions={<Link href="/llm-settings" className="btn-secondary"><Wrench size={14} /> Runtime setup</Link>}
            />
          )}
          {error && <Panel tone="#b91c1c" icon={AlertTriangle} title="Launch failed" body={error} />}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn-primary" disabled={!canLaunch} onClick={() => void launch()}>
              {launching ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
              Launch SDLC Workflow
            </button>
            <Link href="/workflows/templates/gallery" className="btn-secondary"><GitBranch size={15} /> Template gallery</Link>
            <Link href="/agents/studio" className="btn-secondary"><Bot size={15} /> Agent Studio</Link>
          </div>

          {result && (
            <Panel
              tone={result.workflowInstance?.id ? "#047857" : "#b45309"}
              icon={result.workflowInstance?.id ? CheckCircle2 : AlertTriangle}
              title={result.workflowInstance?.id ? "Run launched" : "WorkItems created"}
              body={result.workflowInstance?.id ? `Run ${shortId(result.workflowInstance.id)} is ready in the unified run cockpit.` : "No run was started automatically. Open WorkItems to attach/start a workflow."}
              actions={
                <>
                  {resultWorkbenchUrl && <Link href={resultWorkbenchUrl} className="btn-primary"><Rocket size={14} /> Open Workbench Neo</Link>}
                  {result.runUrl && <Link href={result.runUrl} className={resultWorkbenchUrl ? "btn-secondary" : "btn-primary"}><Rocket size={14} /> Open run</Link>}
                  <Link href="/work-items" className="btn-secondary"><ClipboardList size={14} /> WorkItems</Link>
                </>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: "grid", gap: 6 }}><span className="label-xs">{label}</span>{children}</label>;
}

function inputStyle(extra: CSSProperties = {}): CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    border: "1px solid var(--color-outline-variant)",
    borderRadius: 8,
    padding: "9px 11px",
    background: "#fff",
    color: "var(--color-on-surface)",
    fontSize: 13,
    outline: "none",
    ...extra,
  };
}

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <article className="card" style={{ padding: 14, display: "flex", gap: 11, alignItems: "center", boxShadow: "none" }}>
      <span style={{ width: 38, height: 38, borderRadius: 8, display: "grid", placeItems: "center", color: tone, background: `${tone}12` }}><Icon size={17} /></span>
      <span>
        <span className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</span>
        <strong style={{ display: "block", color: tone, fontSize: 18 }}>{value}</strong>
      </span>
    </article>
  );
}

function Prerequisites({
  checks,
  blockers,
  warnings,
}: {
  checks: PrereqCheck[];
  blockers: StartBlocker[];
  warnings: StartBlocker[];
}) {
  const allReady = checks.every((check) => check.ok || check.optional);
  const missingChecks = checks.filter((check) => !check.ok && !check.optional).map((check) => check.label);
  const footnoteIssues = allReady ? warnings : blockers;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {checks.map((check) => (
          <StatusChip
            key={check.label}
            state={check.ok ? "ready" : check.optional ? "optional" : "blocked"}
            label={check.label}
          />
        ))}
      </div>
      {allReady ? (
        <Panel
          tone="#047857"
          icon={CheckCircle2}
          title="Prerequisites ready"
          body={warnings.length ? "Required launch checks are ready. Optional setup notes below do not block launch." : "Capability, workflow seed, runtime, and LLM provider checks are sufficient to launch."}
          footnote={warnings.slice(0, 2).map((warning) => warning.message).join(" ")}
        />
      ) : (
        <Panel
          tone="#b45309"
          icon={AlertTriangle}
          title="Prerequisites need attention"
          body={missingChecks.length ? `Resolve required checks before launching: ${missingChecks.join(", ")}.` : "Resolve required launch checks before launching."}
          actions={
            <>
              <Link href="/llm-settings" className="btn-secondary"><Wrench size={14} /> Runtime setup</Link>
              <Link href="/operations/readiness" className="btn-secondary"><ShieldCheck size={14} /> Readiness</Link>
            </>
          }
          footnote={footnoteIssues.slice(0, 2).map((issue) => issue.message).join(" ")}
        />
      )}
    </div>
  );
}

function Panel({
  tone,
  icon: Icon,
  title,
  body,
  actions,
  footnote,
}: {
  tone: string;
  icon: LucideIcon;
  title: string;
  body: string;
  actions?: ReactNode;
  footnote?: string;
}) {
  return (
    <section style={{ border: `1px solid ${tone}33`, background: `${tone}10`, borderRadius: 8, padding: 13, color: tone }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 850, marginBottom: 5 }}>
        <Icon size={16} /> {title}
      </div>
      <p style={{ margin: 0, color: "var(--color-on-surface)", fontSize: 13, lineHeight: 1.5 }}>{body}</p>
      {footnote && <p style={{ margin: "7px 0 0", fontSize: 12, lineHeight: 1.45 }}>{footnote}</p>}
      {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>{actions}</div>}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 16, color: "var(--color-outline)", fontSize: 13 }}>{text}</div>;
}
