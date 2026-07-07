"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  GitBranch,
  Loader2,
  Network,
  Play,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { CopyButton } from "@/components/ui/CopyButton";
import { EvidenceRail, IconTile, MetricStrip, StatusPill, Timeline, type UiState } from "@/components/ui/primitives";
import { asBoolean, asRow, asRowArray, asString, asStringArray } from "@/lib/row";

type StartBlocker = {
  id: string;
  label: string;
  message: string;
  severity: "blocked" | "warning";
  fixCommand?: string;
  fixRoute?: string;
};

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
  modelReadiness?: {
    alias: string;
    ready: boolean;
    source: string;
    defaultAlias?: string | null;
    readyAliases?: string[];
    warnings?: string[];
  };
  sampleStories: Array<{ intent: string; label: string; story: string }>;
  intents: Array<{ id: string; label: string; description?: string; templateCount?: number; workflowTemplate?: { id?: string; name?: string } }>;
  capabilities: Array<{ id: string; name: string; capabilityType?: string | null; status?: string | null }>;
  blockers: StartBlocker[];
  warnings: StartBlocker[];
  health?: {
    score?: number;
    summary?: { connectedRuntimeCount?: number; readyProviderCount?: number; seededIntentCount?: number };
  };
};

type LaunchResult = {
  runUrl?: string | null;
  workItemsUrl?: string | null;
  workItems?: Array<{ id?: string; workCode?: string }>;
  failedWorkItems?: Array<{ title?: string; error?: string }>;
  workflowTemplate?: { id?: string; name?: string; profile?: string | null } | null;
  workflowInstance?: { id?: string; name?: string; status?: string } | null;
  recommendation?: StartRecommendation;
  warnings?: string[];
};

type OnboardingState = {
  deploymentMode: "docker" | "bare-metal" | "split-runtime" | "unknown";
  completedSteps: string[];
  dismissedTips: string[];
  preferredIntent?: string;
  preferredModelAlias?: string;
};

const starterStory = "As a product owner, I want a governed agentic SDLC workflow that splits a story into WorkItems, launches design/coding/testing gates, and exports delivery evidence plus a Copilot handoff.";

const deploymentCommands = {
  docker: "git pull --ff-only\n./singularity.sh up\nbin/doctor.sh",
  "bare-metal": "git pull --ff-only\nbin/setup.sh --yes\nbin/bare-metal-apps.sh smoke",
  "split-runtime": "git pull --ff-only\nbin/setup.sh --yes\n# terminal 1\nbin/bare-metal-apps.sh up\n# terminal 2, on laptop/runtime host\nbin/mcp-runtime-setup.sh",
  unknown: "bin/setup.sh --yes\nbin/doctor.sh --fix",
} as const;

const deploymentModes = new Set<OnboardingState["deploymentMode"]>(["docker", "bare-metal", "split-runtime", "unknown"]);
const blockerSeverities = new Set<StartBlocker["severity"]>(["blocked", "warning"]);

function statusFromBlocker(blocker: StartBlocker): UiState {
  return blocker.severity === "blocked" ? "blocked" : "degraded";
}

function shortId(value?: string | null): string {
  if (!value) return "-";
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

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

function normalizeDeploymentMode(value: unknown): OnboardingState["deploymentMode"] {
  const mode = asString(value);
  return deploymentModes.has(mode as OnboardingState["deploymentMode"])
    ? mode as OnboardingState["deploymentMode"]
    : "unknown";
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

function normalizeStartPreview(value: unknown, fallbackStory: string): StartPreview {
  const row = asRow(value);
  const readiness = asRow(row.modelReadiness);
  const health = asRow(row.health);
  const summary = asRow(health.summary);
  const normalizedBlockers = asRowArray(row.blockers).map(normalizeBlocker);
  const normalizedWarnings = asRowArray(row.warnings).map(normalizeBlocker);
  return {
    story: asString(row.story, fallbackStory),
    recommendation: normalizeRecommendation(row.recommendation),
    ...(Object.keys(readiness).length > 0 ? {
      modelReadiness: {
        alias: asString(readiness.alias, "mock"),
        ready: asBoolean(readiness.ready),
        source: asString(readiness.source, "unknown"),
        defaultAlias: nullableString(readiness.defaultAlias),
        readyAliases: asStringArray(readiness.readyAliases),
        warnings: asStringArray(readiness.warnings),
      },
    } : {}),
    sampleStories: asRowArray(row.sampleStories).map((item, index) => ({
      intent: asString(item.intent, `sample-${index}`),
      label: asString(item.label, `Sample ${index + 1}`),
      story: asString(item.story, starterStory),
    })),
    intents: asRowArray(row.intents).map((item, index) => {
      const workflowTemplate = asRow(item.workflowTemplate);
      return {
        id: asString(item.id, `intent-${index}`),
        label: asString(item.label, `Intent ${index + 1}`),
        description: optionalString(item.description),
        templateCount: asNumber(item.templateCount),
        workflowTemplate: Object.keys(workflowTemplate).length > 0
          ? {
            id: optionalString(workflowTemplate.id),
            name: optionalString(workflowTemplate.name),
          }
          : undefined,
      };
    }),
    capabilities: asRowArray(row.capabilities).map((item, index) => ({
      id: asString(item.id, `capability-${index}`),
      name: asString(item.name, `Capability ${index + 1}`),
      capabilityType: nullableString(item.capabilityType),
      status: nullableString(item.status),
    })),
    blockers: normalizedBlockers,
    warnings: normalizedWarnings.length
      ? normalizedWarnings
      : normalizedBlockers.filter((blocker) => blocker.severity === "warning"),
    health: {
      score: asNumber(health.score),
      summary: {
        connectedRuntimeCount: asNumber(summary.connectedRuntimeCount),
        readyProviderCount: asNumber(summary.readyProviderCount),
        seededIntentCount: asNumber(summary.seededIntentCount),
      },
    },
  };
}

function normalizeLaunchResult(value: unknown): LaunchResult {
  const row = asRow(value);
  return {
    runUrl: nullableString(row.runUrl),
    workItemsUrl: nullableString(row.workItemsUrl),
    workItems: asRowArray(row.workItems).map((item) => ({
      id: optionalString(item.id),
      workCode: optionalString(item.workCode),
    })),
    failedWorkItems: asRowArray(row.failedWorkItems).map((item) => ({
      title: optionalString(item.title),
      error: optionalString(item.error),
    })),
    workflowTemplate: Object.keys(asRow(row.workflowTemplate)).length > 0
      ? {
        id: optionalString(asRow(row.workflowTemplate).id),
        name: optionalString(asRow(row.workflowTemplate).name),
        profile: nullableString(asRow(row.workflowTemplate).profile),
      }
      : null,
    workflowInstance: Object.keys(asRow(row.workflowInstance)).length > 0
      ? {
        id: optionalString(asRow(row.workflowInstance).id),
        name: optionalString(asRow(row.workflowInstance).name),
        status: optionalString(asRow(row.workflowInstance).status),
      }
      : null,
    recommendation: Object.keys(asRow(row.recommendation)).length > 0 ? normalizeRecommendation(row.recommendation) : undefined,
    warnings: asStringArray(row.warnings),
  };
}

function normalizeOnboardingState(value: unknown): OnboardingState {
  const row = asRow(value);
  return {
    deploymentMode: normalizeDeploymentMode(row.deploymentMode),
    completedSteps: asStringArray(row.completedSteps),
    dismissedTips: asStringArray(row.dismissedTips),
    ...(optionalString(row.preferredIntent) ? { preferredIntent: optionalString(row.preferredIntent) } : {}),
    ...(optionalString(row.preferredModelAlias) ? { preferredModelAlias: optionalString(row.preferredModelAlias) } : {}),
  };
}

function normalizeOnboardingEnvelope(value: unknown): { state: OnboardingState } {
  return { state: normalizeOnboardingState(asRow(value).state) };
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(apiPath(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  assertValidApiResponse(path, raw, parseError);
  return parsed;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(apiPath(path), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  assertValidApiResponse(path, raw, parseError);
  return parsed;
}

export default function StartPage() {
  const [story, setStory] = useState(starterStory);
  const [intent, setIntent] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [modelAlias, setModelAlias] = useState("");
  const [runtimePreference, setRuntimePreference] = useState("");
  const [governancePreset, setGovernancePreset] = useState("");
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState>({ deploymentMode: "unknown", completedSteps: [], dismissedTips: [] });
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recommendation = preview?.recommendation;
  const blockingIssues = (preview?.blockers ?? []).filter((item) => item.severity === "blocked");
  const warningIssues = preview?.warnings?.length
    ? preview.warnings
    : (preview?.blockers ?? []).filter((item) => item.severity === "warning");
  const canLaunch = Boolean(
    story.trim().length >= 8
    && (capabilityId || recommendation?.capabilityId)
    && recommendation?.workflowTemplateId
    && blockingIssues.length === 0
    && !launching,
  );
  const selectedCapabilityName = useMemo(() => {
    const id = capabilityId || recommendation?.capabilityId;
    return preview?.capabilities.find((capability) => capability.id === id)?.name ?? recommendation?.capabilityName ?? null;
  }, [capabilityId, preview?.capabilities, recommendation?.capabilityId, recommendation?.capabilityName]);

  async function loadPreview(next: Partial<{ story: string; intent: string; capabilityId: string; modelAlias: string; runtimePreference: string; governancePreset: string }> = {}) {
    setLoadingPreview(true);
    setError(null);
    try {
      const data = normalizeStartPreview(await postJson("/api/start/preview", {
        story: next.story ?? story,
        intent: next.intent ?? intent,
        capabilityId: next.capabilityId ?? capabilityId,
        modelAlias: next.modelAlias ?? modelAlias,
        runtimePreference: next.runtimePreference ?? runtimePreference,
        governancePreset: next.governancePreset ?? governancePreset,
      }), next.story ?? story);
      setPreview(data);
      setStory(data.story);
      setIntent(data.recommendation.intent);
      setCapabilityId(data.recommendation.capabilityId ?? "");
      setModelAlias(data.recommendation.modelAlias);
      setRuntimePreference(data.recommendation.runtimePreference);
      setGovernancePreset(data.recommendation.governancePreset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not preview SDLC start.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function launch() {
    setLaunching(true);
    setError(null);
    setLaunchResult(null);
    try {
      const result = normalizeLaunchResult(await postJson("/api/start/launch", {
        story,
        intent,
        capabilityId,
        modelAlias,
        runtimePreference,
        governancePreset,
      }));
      setLaunchResult(result);
      await saveOnboarding({ completedSteps: [...onboarding.completedSteps, "launched-first-sdlc-run"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed.");
    } finally {
      setLaunching(false);
    }
  }

  async function saveOnboarding(patch: Partial<OnboardingState>) {
    const next = {
      ...onboarding,
      ...patch,
      completedSteps: Array.from(new Set([...(onboarding.completedSteps ?? []), ...(patch.completedSteps ?? [])])),
      dismissedTips: Array.from(new Set([...(onboarding.dismissedTips ?? []), ...(patch.dismissedTips ?? [])])),
    };
    setOnboarding(next);
    try {
      const saved = normalizeOnboardingEnvelope(await postJson("/api/onboarding/state", next));
      setOnboarding(saved.state);
    } catch {
      // Cookie persistence is convenience only; keep the in-memory state.
    }
  }

  useEffect(() => {
    void loadPreview();
    void getJson("/api/onboarding/state")
      .then((data) => setOnboarding(normalizeOnboardingEnvelope(data).state))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto grid w-full gap-5" style={{ maxWidth: 1380 }}>
      <section className="page-hero">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <IconTile icon={Sparkles} tone="emerald" size="sm" />
              First-run SDLC launchpad
            </div>
            <h1 className="page-header text-4xl">Paste Story. Launch Workflow. Export Evidence.</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Start here when you want the platform to choose the right SDLC intent, validate setup, create WorkItems, and open the unified run cockpit.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary" href="/workflows/planner"><ClipboardList size={15} /> Planner</Link>
            <Link className="btn-secondary" href="/llm-settings"><Network size={15} /> Runtime + LLM</Link>
            <Link className="btn-secondary" href="/operations/readiness"><ShieldCheck size={15} /> Health</Link>
          </div>
        </div>
        <div className="mt-5">
          <EvidenceRail
            items={[
              { label: "Story", detail: "Capture request", icon: ClipboardList, state: story.trim().length >= 8 ? "ready" : "waiting" },
              { label: "WorkItems", detail: "Split and route", icon: GitBranch, state: launchResult?.workItems?.length ? "ready" : "waiting" },
              { label: "Workflow", detail: recommendation?.intentLabel ?? "Recommended", icon: Rocket, state: recommendation?.workflowTemplateId ? "ready" : "blocked" },
              { label: "Run", detail: launchResult?.workflowInstance?.id ? shortId(launchResult.workflowInstance.id) : "Not launched", icon: Play, state: launchResult?.workflowInstance?.id ? "ready" : "waiting" },
              { label: "Evidence", detail: "Receipts + Copilot YAML", icon: FileCheck2, state: launchResult?.workflowInstance?.id ? "ready" : "optional" },
            ]}
          />
        </div>
      </section>

      <MetricStrip
        items={[
          { label: "Adoption score", value: `${preview?.health?.score ?? 0}%`, icon: ShieldCheck, state: (preview?.health?.score ?? 0) >= 80 ? "ready" : "degraded" },
          { label: "Runtime bridge", value: preview?.health?.summary?.connectedRuntimeCount ?? 0, icon: Network, state: (preview?.health?.summary?.connectedRuntimeCount ?? 0) > 0 ? "ready" : "needs-runtime" },
          { label: "LLM providers", value: preview?.health?.summary?.readyProviderCount ?? 0, icon: Wand2, state: (preview?.health?.summary?.readyProviderCount ?? 0) > 0 ? "ready" : "degraded" },
          { label: "Mode", value: recommendation?.demoMode ? "Demo" : "Live", icon: Sparkles, state: recommendation?.demoMode ? "optional" : "ready" },
        ]}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_420px]">
        <section className="data-panel">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="label-xs mb-1 text-slate-500">One-click story to run</div>
              <h2 className="text-xl font-black text-slate-950">Describe the work</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">Use a sample story or paste your own. Preview will choose the SDLC intent, template, runtime mode, and model alias.</p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => void loadPreview()} disabled={loadingPreview}>
              {loadingPreview ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              Preview
            </button>
          </div>

          <textarea
            value={story}
            onChange={(event) => setStory(event.target.value)}
            rows={9}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            {(preview?.sampleStories ?? []).slice(0, 6).map((sample) => (
              <button
                key={sample.intent}
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void loadPreview({ story: sample.story, intent: sample.intent })}
              >
                {sample.label}
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <Field label="Recommended intent">
              <select className="control" value={intent} onChange={(event) => { setIntent(event.target.value); void loadPreview({ intent: event.target.value }); }}>
                {(preview?.intents ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="Capability">
              <select className="control" value={capabilityId} onChange={(event) => { setCapabilityId(event.target.value); void loadPreview({ capabilityId: event.target.value }); }}>
                {(preview?.capabilities ?? []).map((capability) => <option key={capability.id} value={capability.id}>{capability.name}</option>)}
              </select>
            </Field>
            <Field label="Model alias">
              <input className="control" value={modelAlias} onChange={(event) => setModelAlias(event.target.value)} />
            </Field>
            <Field label="Runtime preference">
              <select className="control" value={runtimePreference} onChange={(event) => setRuntimePreference(event.target.value)}>
                <option value="user_runtime">User runtime</option>
                <option value="tenant_runtime">Tenant runtime</option>
                <option value="mock_ok">Mock allowed</option>
              </select>
            </Field>
            <Field label="Governance preset">
              <select className="control" value={governancePreset} onChange={(event) => setGovernancePreset(event.target.value)}>
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
                <option value="evidence_first">Evidence first</option>
              </select>
            </Field>
            <Field label="Workflow template">
              <input className="control" value={recommendation?.workflowTemplateName ?? recommendation?.workflowTemplateId ?? "No seeded template"} readOnly />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={!canLaunch} onClick={() => void launch()}>
              {launching ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
              Launch SDLC Workflow
            </button>
            <Link className="btn-secondary" href="/workflows/start"><Play size={15} /> Advanced launcher</Link>
            <Link className="btn-secondary" href="/agents/studio"><Sparkles size={15} /> Create agent</Link>
          </div>

          {error && <HumanError message={error} />}
          {launchResult && <LaunchResultPanel result={launchResult} />}
        </section>

        <aside className="grid gap-5">
          <section className="data-panel">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="label-xs mb-1 text-slate-500">Recommendation</div>
                <h2 className="text-lg font-black text-slate-950">{recommendation?.intentLabel ?? "Loading..."}</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {selectedCapabilityName ? `Capability: ${selectedCapabilityName}` : "Capability will be selected from your platform seeds."}
                </p>
              </div>
              <StatusPill state={recommendation?.demoMode ? "optional" : "ready"} label={recommendation?.demoMode ? "Demo fallback" : "Live path"} />
            </div>
            <Timeline
              items={[
                { title: "Intent", detail: recommendation?.intentLabel ?? "Choose an SDLC intent", state: recommendation?.intent ? "ready" : "waiting", icon: GitBranch },
                { title: "Template", detail: recommendation?.workflowTemplateName ?? recommendation?.workflowTemplateId ?? "Missing seeded workflow", state: recommendation?.workflowTemplateId ? "ready" : "blocked", icon: Rocket },
                { title: "Runtime", detail: runtimePreference || "Not selected", state: runtimePreference === "mock_ok" ? "optional" : "ready", icon: Network },
                {
                  title: "Model",
                  detail: modelAlias || "Not selected",
                  state: preview?.modelReadiness?.ready ? "ready" : modelAlias === "mock" ? "optional" : "blocked",
                  icon: Wand2,
                },
              ]}
            />
            {preview?.modelReadiness && !preview.modelReadiness.ready && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">
                <strong>Model alias blocked:</strong> {preview.modelReadiness.alias} is not ready. {(preview.modelReadiness.warnings ?? []).join(" ") || "Choose a ready alias from Runtime + LLM."}
              </div>
            )}
          </section>

          <SetupAssistant
            blockers={blockingIssues}
            warnings={warningIssues}
            deploymentMode={onboarding.deploymentMode}
            onDeploymentMode={(deploymentMode) => void saveOnboarding({ deploymentMode })}
          />
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold text-slate-700">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function SetupAssistant({
  blockers,
  warnings,
  deploymentMode,
  onDeploymentMode,
}: {
  blockers: StartBlocker[];
  warnings: StartBlocker[];
  deploymentMode: OnboardingState["deploymentMode"];
  onDeploymentMode: (mode: OnboardingState["deploymentMode"]) => void;
}) {
  const issues = [...blockers, ...warnings];
  return (
    <section className="data-panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="label-xs mb-1 text-slate-500">Setup assistant</div>
          <h2 className="text-lg font-black text-slate-950">Fix prerequisites inline</h2>
        </div>
        <StatusPill state={blockers.length ? "blocked" : warnings.length ? "degraded" : "ready"} />
      </div>

      <label className="mb-3 block text-sm font-semibold text-slate-700">
        <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Deployment path</span>
        <select className="control" value={deploymentMode} onChange={(event) => onDeploymentMode(event.target.value as OnboardingState["deploymentMode"])}>
          <option value="unknown">Auto / unknown</option>
          <option value="docker">Docker Compose</option>
          <option value="bare-metal">Bare-metal apps</option>
          <option value="split-runtime">Split runtime</option>
        </select>
      </label>

      <CommandBlock label="Recommended setup command" command={deploymentCommands[deploymentMode]} />

      <div className="mt-4 grid gap-3">
        {issues.map((issue) => (
          <div key={`${issue.id}-${issue.message}`} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {issue.severity === "blocked" ? <AlertTriangle size={15} className="text-red-600" /> : <AlertTriangle size={15} className="text-amber-600" />}
                <strong className="text-sm text-slate-950">{issue.label}</strong>
              </div>
              <StatusPill state={statusFromBlocker(issue)} />
            </div>
            <p className="text-xs leading-5 text-slate-600">{issue.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {issue.fixCommand && <CommandBlock compact label="Fix command" command={issue.fixCommand} />}
              {issue.fixRoute && <Link className="btn-secondary text-xs" href={issue.fixRoute}>Open fix route</Link>}
            </div>
          </div>
        ))}
        {issues.length === 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 size={15} className="mr-1 inline" />
            Required SDLC prerequisites are ready.
          </div>
        )}
      </div>
    </section>
  );
}

function CommandBlock({ label, command, compact = false }: { label: string; command: string; compact?: boolean }) {
  return (
    <div className={compact ? "min-w-[220px] flex-1" : ""}>
      <div className="mb-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="rounded-lg border border-slate-200 bg-slate-950 text-slate-50">
        <div className="flex items-start justify-between gap-2 p-2">
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-5"><code>{command}</code></pre>
          <CopyButton text={command} label={`Copy ${label}`} />
        </div>
      </div>
    </div>
  );
}

function HumanError({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <div className="mb-2 flex items-center gap-2 font-black"><AlertTriangle size={16} /> Could not continue</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <p><strong>What happened:</strong> {message}</p>
        <p><strong>How to fix:</strong> Check setup assistant blockers, then run Preview again.</p>
      </div>
    </div>
  );
}

function LaunchResultPanel({ result }: { result: LaunchResult }) {
  const runId = result.workflowInstance?.id;
  return (
    <section className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black text-emerald-950">
            <CheckCircle2 size={16} />
            {runId ? "Workflow run launched" : "WorkItems created"}
          </div>
          <p className="mt-1 text-xs leading-5 text-emerald-800">
            {runId ? `Run ${shortId(runId)} is ready in the unified run cockpit.` : "The planner created WorkItems but did not start a workflow run."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {result.runUrl && <Link className="btn-primary text-xs" href={result.runUrl}>Open run</Link>}
          {runId && <Link className="btn-secondary text-xs" href={`/runs/${encodeURIComponent(runId)}`}>Run cockpit</Link>}
          <Link className="btn-secondary text-xs" href="/work-items">WorkItems</Link>
        </div>
      </div>
      {(result.warnings ?? []).length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-emerald-800">
          {result.warnings!.slice(0, 5).map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
        </ul>
      )}
    </section>
  );
}
