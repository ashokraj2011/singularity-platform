"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
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
import { apiPath, authHeaders, readResponseBody, responseMessage, runtimeApi } from "@/lib/api";
import { shortId } from "@/lib/workgraph";
import { isWorkbenchProfile, workbenchNeoUrl } from "@/lib/workbenchLaunch";
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
type GalleryResponse = { items?: GalleryItem[] };
type AdoptionHealth = {
  score?: number;
  summary?: {
    connectedRuntimeCount?: number;
    readyProviderCount?: number;
    seededIntentCount?: number;
  };
  blocked?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
  warning?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(apiPath(url), { cache: "no-store", headers: { "Content-Type": "application/json", ...authHeaders() } });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return parsed as T;
}

const fallbackStory = "As a platform team, I want a governed agentic SDLC workflow that turns a story into WorkItems, runs implementation, captures tests, and exports delivery evidence.";

export default function WorkflowStartPage() {
  const { data: capabilities = [], error: capabilitiesError } = useSWR("workflow-start-capabilities", () => runtimeApi.listCapabilities() as Promise<Capability[]>);
  const { data: gallery, error: galleryError } = useSWR("workflow-template-gallery", () => fetchJson<GalleryResponse>("/api/workflow-templates/gallery"));
  const { data: health, error: healthError, mutate: refreshHealth } = useSWR("adoption-health", () => fetchJson<AdoptionHealth>("/api/adoption/health"), { refreshInterval: 15000 });

  const intents = gallery?.items ?? [];
  const [intentId, setIntentId] = useState("build_feature");
  const [capabilityId, setCapabilityId] = useState("");
  const [story, setStory] = useState(fallbackStory);
  const [modelAlias, setModelAlias] = useState("balanced");
  const [runtimePreference, setRuntimePreference] = useState("user_runtime");
  const [governancePreset, setGovernancePreset] = useState("standard");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  const selectedIntent = useMemo(() => intents.find((item) => item.id === intentId) ?? intents[0] ?? null, [intentId, intents]);
  const selectedCapability = capabilities.find((capability) => capability.id === capabilityId) ?? null;
  const runtimeConnected = (health?.summary?.connectedRuntimeCount ?? 0) > 0;
  const llmReady = (health?.summary?.readyProviderCount ?? 0) > 0;
  const requiresRuntime = runtimePreference !== "mock_ok" && selectedIntent?.runtimePreference !== "mock_ok";
  const requiresRealModel = modelAlias !== "mock";
  const hasTemplate = Boolean(selectedIntent?.workflowTemplate?.id);
  const canLaunch = Boolean(capabilityId && story.trim().length >= 8 && hasTemplate && (!requiresRuntime || runtimeConnected) && (!requiresRealModel || llmReady) && !launching);
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const intent = params.get("intent");
    if (intent) setIntentId(intent);
  }, []);

  function applyIntent(item: GalleryItem) {
    setIntentId(item.id);
    setStory(item.sampleStory || fallbackStory);
    setModelAlias(item.defaultModelAlias || "balanced");
    setRuntimePreference(item.runtimePreference || "user_runtime");
    setGovernancePreset(item.governancePreset || "standard");
    setResult(null);
    setError(null);
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
      const { raw, parsed } = await readResponseBody(res);
      if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
      setResult(parsed as LaunchResult);
      void refreshHealth();
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
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
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
        <Metric icon={Sparkles} label="LLM providers" value={`${health?.summary?.readyProviderCount ?? 0} ready`} tone={llmReady ? "#047857" : "#b45309"} />
        <Metric icon={GitBranch} label="Seeded intents" value={`${health?.summary?.seededIntentCount ?? 0}/${intents.length || 0}`} tone={hasTemplate ? "#047857" : "#b45309"} />
      </section>

      {(capabilitiesError || galleryError || healthError) && (
        <section className="data-panel" style={{ padding: 14, borderColor: "#fde68a", background: "#fffbeb", color: "#92400e", marginBottom: 16 }}>
          {String(capabilitiesError?.message ?? galleryError?.message ?? healthError?.message)}
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
                border: item.id === intentId ? "1px solid rgba(54,135,39,0.45)" : "1px solid var(--color-outline-variant)",
                background: item.id === intentId ? "rgba(240,253,244,0.82)" : "#fff",
                borderRadius: 8,
                padding: 13,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <strong>{item.label}</strong>
                <span className={item.workflowTemplate ? "badge badge-active" : "badge badge-pending_approval"}>
                  {item.workflowTemplate ? "seeded" : "missing"}
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
              <select value={capabilityId} onChange={(event) => setCapabilityId(event.target.value)} style={inputStyle()}>
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

          <Prerequisites checks={prereqChecks} warnings={health?.warning ?? []} />
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
  warnings,
}: {
  checks: PrereqCheck[];
  warnings: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
}) {
  const allReady = checks.every((check) => check.ok || check.optional);
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
        <Panel tone="#047857" icon={CheckCircle2} title="Prerequisites ready" body="Capability, workflow seed, runtime, and LLM provider checks are sufficient to launch." />
      ) : (
        <Panel
          tone="#b45309"
          icon={AlertTriangle}
          title="Prerequisites need attention"
          body="Resolve the blocked checks above before launching."
          actions={
            <>
              <Link href="/llm-settings" className="btn-secondary"><Wrench size={14} /> Runtime setup</Link>
              <Link href="/operations/readiness" className="btn-secondary"><ShieldCheck size={14} /> Readiness</Link>
            </>
          }
          footnote={warnings.slice(0, 2).map((warning) => warning.summary).join(" ")}
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
