"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FlaskConical,
  GitBranch,
  Layers3,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
} from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { workgraphFetch } from "@/lib/workgraph";

type Kind = "SINGLE" | "PHASE" | "TOOL";
type FailureMode = "REPAIR" | "REVIEW" | "BLOCK";
type Phase = "PLAN" | "EXPLORE" | "ACT" | "VERIFY" | "SELF_REVIEW" | "REPAIR" | "FINALIZE";

type Definition = {
  kind: Kind;
  phaseOrder: Phase[];
  loopStageKey: string;
  loopAgentRole?: string;
  promptProfileKey?: string;
  maxTurns: number;
  earlyStop: boolean;
  validationFailure: FailureMode;
  maxRepairAttempts: number;
  tools: string[];
};

type Strategy = {
  id: string;
  name: string;
  description?: string | null;
  kind: Kind;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | string;
  currentVersion: number;
  updatedAt?: string;
  latestVersion?: { version: number; definition?: Definition; contentHash?: string } | null;
  latestPublishedVersion?: { version: number; publishedAt?: string | null; contentHash?: string } | null;
};

type Tool = { name: string; description: string; inputSchema?: Record<string, unknown>; readOnly?: boolean };
type PromptProfile = { id?: string; key?: string; name?: string; label?: string };

const PHASES: Phase[] = ["PLAN", "EXPLORE", "ACT", "VERIFY", "SELF_REVIEW", "REPAIR", "FINALIZE"];
const ROLES = ["PRODUCT", "ARCHITECT", "ENGINEER", "QA", "SECURITY", "RELEASE"];

const initialDefinition = (): Definition => ({
  kind: "PHASE",
  phaseOrder: ["PLAN", "VERIFY", "SELF_REVIEW"],
  loopStageKey: "loop.stage",
  loopAgentRole: "QA",
  maxTurns: 5,
  earlyStop: true,
  validationFailure: "REPAIR",
  maxRepairAttempts: 2,
  tools: [],
});

function displayKind(kind: string): string {
  if (kind === "SINGLE") return "Single call";
  if (kind === "TOOL") return "Read-only tool loop";
  return "Phase loop";
}

function statusColor(status: string): string {
  if (status === "PUBLISHED") return "#047857";
  if (status === "DRAFT") return "#b45309";
  return "#64748b";
}

function formatDate(value?: string): string {
  if (!value) return "Not published";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function maxCalls(definition: Definition): number {
  if (definition.kind === "SINGLE") return 1;
  if (definition.kind === "TOOL") return definition.maxTurns;
  return Math.min(definition.maxTurns, definition.phaseOrder.length + (definition.validationFailure === "REPAIR" ? definition.maxRepairAttempts : 0));
}

function cleanDefinition(value?: Definition | null): Definition {
  const next = value ?? initialDefinition();
  return {
    ...initialDefinition(),
    ...next,
    kind: next.kind === "SINGLE" || next.kind === "TOOL" ? next.kind : "PHASE",
    phaseOrder: Array.isArray(next.phaseOrder) ? next.phaseOrder.filter((item): item is Phase => PHASES.includes(item as Phase)) : [],
    tools: Array.isArray(next.tools) ? next.tools.map(String) : [],
  };
}

export function LoopStrategiesConsole() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [name, setName] = useState("Verifier review loop");
  const [description, setDescription] = useState("Bounded verification and repair for structured Direct LLM output.");
  const [definition, setDefinition] = useState<Definition>(initialDefinition);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [validation, setValidation] = useState<{ ok: boolean; failures?: Array<{ field: string; message: string }>; warnings?: string[] } | null>(null);

  const { data: strategyData, error: strategyError, isLoading, mutate } = useSWR<{ items?: Strategy[] }>(
    "/loop-strategies?kind=DIRECT_LLM_TASK",
    (path: string) => workgraphFetch<{ items?: Strategy[] }>(path),
    { revalidateOnFocus: false },
  );
  const { data: toolData } = useSWR<{ items?: Tool[] }>(
    "/direct-llm/tools",
    (path: string) => workgraphFetch<{ items?: Tool[] }>(path),
    { revalidateOnFocus: false },
  );
  const { data: promptProfiles } = useSWR<PromptProfile[]>(
    "direct-llm-prompt-profiles",
    () => runtimeApi.listProfiles() as Promise<PromptProfile[]>,
    { revalidateOnFocus: false },
  );

  const strategies = strategyData?.items ?? [];
  const selected = strategies.find((item) => item.id === selectedId) ?? null;
  const tools = toolData?.items ?? [];
  const estimatedCalls = maxCalls(definition);

  function startNew() {
    setSelectedId(null);
    setIsNew(true);
    setName("Verifier review loop");
    setDescription("Bounded verification and repair for structured Direct LLM output.");
    setDefinition(initialDefinition());
    setValidation(null);
    setMessage(null);
    setStep(1);
  }

  function selectStrategy(strategy: Strategy) {
    setSelectedId(strategy.id);
    setIsNew(false);
    setName(strategy.name);
    setDescription(strategy.description ?? "");
    setDefinition(cleanDefinition(strategy.latestVersion?.definition));
    setValidation(null);
    setMessage(null);
    setStep(1);
  }

  function updateDefinition(patch: Partial<Definition>) {
    setDefinition((current) => ({ ...current, ...patch }));
    setValidation(null);
  }

  function addPhase(phase: Phase) {
    if (!definition.phaseOrder.includes(phase)) updateDefinition({ phaseOrder: [...definition.phaseOrder, phase] });
  }

  function removePhase(index: number) {
    updateDefinition({ phaseOrder: definition.phaseOrder.filter((_, itemIndex) => itemIndex !== index) });
  }

  function movePhase(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= definition.phaseOrder.length) return;
    const next = [...definition.phaseOrder];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    updateDefinition({ phaseOrder: next });
  }

  async function validateDefinition() {
    setMessage(null);
    try {
      const result = await workgraphFetch<{ ok: boolean; failures?: Array<{ field: string; message: string }>; warnings?: string[] }>("/loop-strategies/validate", {
        method: "POST",
        body: JSON.stringify({ definition }),
      });
      setValidation(result);
      if (!result.ok) setMessage({ tone: "error", text: "Fix the highlighted strategy validation errors before saving." });
      else setMessage({ tone: "success", text: "Strategy is valid and ready to save." });
      return result.ok;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Strategy validation failed." });
      return false;
    }
  }

  async function save(publish: boolean) {
    if (!name.trim()) {
      setMessage({ tone: "error", text: "Give the strategy a name before saving." });
      return;
    }
    const valid = await validateDefinition();
    if (!valid) return;
    setSaving(true);
    try {
      if (isNew || !selectedId) {
        const result = await workgraphFetch<{ strategy?: Strategy }>("/loop-strategies", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, kind: definition.kind, definition, publish }),
        });
        const createdId = result.strategy?.id;
        await mutate();
        if (createdId) {
          setSelectedId(createdId);
          setIsNew(false);
        }
        setMessage({ tone: "success", text: publish ? "Published strategy version 1." : "Saved strategy draft." });
      } else {
        await workgraphFetch(`/loop-strategies/${encodeURIComponent(selectedId)}/versions`, {
          method: "POST",
          body: JSON.stringify({ definition, publish }),
        });
        await mutate();
        setMessage({ tone: "success", text: publish ? "Published a new immutable strategy version." : "Saved a new strategy draft version." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not save loop strategy." });
    } finally {
      setSaving(false);
    }
  }

  const hasEditor = isNew || Boolean(selectedId);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="page-hero">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent-workflow)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <Wand2 size={15} /> Direct LLM task controls
            </div>
            <h1 className="page-header" style={{ margin: 0, fontSize: 32 }}>Loop strategy library</h1>
            <p style={{ margin: "10px 0 0", maxWidth: 780, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              Design bounded single-call, phase, and read-only tool loops once, then pin a published version to any Direct LLM node.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-secondary" href="/workflows/node-types"><Code2 size={15} /> Node types</Link>
            <button type="button" className="btn-primary" onClick={startNew}><Plus size={15} /> New loop strategy</button>
          </div>
        </div>
        <div className="evidence-rail" style={{ marginTop: 18 }}>
          {[{ icon: Layers3, label: "Choose mode", detail: "Single, phase, tool" }, { icon: GitBranch, label: "Design path", detail: "Bounded phases" }, { icon: ShieldCheck, label: "Validate", detail: "Contract-aware" }, { icon: Sparkles, label: "Publish", detail: "Immutable version" }].map(({ icon: Icon, label, detail }) => (
            <div key={label} className="evidence-step"><span style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)" }}><Icon size={16} /></span><span><strong style={{ display: "block", color: "var(--color-on-surface)", fontSize: 13 }}>{label}</strong><span style={{ color: "var(--color-outline)", fontSize: 11 }}>{detail}</span></span></div>
          ))}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(250px, 0.8fr) minmax(0, 1.6fr)", gap: 14, alignItems: "start" }}>
        <section className="data-panel" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
            <div><div className="label-xs" style={{ color: "var(--color-outline)" }}>Tenant library</div><h2 style={{ margin: "4px 0 0", fontSize: 17 }}>Published and draft strategies</h2></div>
            <button type="button" title="Refresh strategies" onClick={() => void mutate()} style={{ border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-outline)", borderRadius: 7, padding: 7, cursor: "pointer" }}><RefreshCw size={14} /></button>
          </div>
          {strategyError && <div className="error-state" style={{ marginBottom: 10 }}>Could not load loop strategies: {strategyError.message}</div>}
          {isLoading && <div style={{ color: "var(--color-outline)", fontSize: 13 }}>Loading strategy library...</div>}
          {!isLoading && strategies.length === 0 && <div className="empty-state"><Wand2 size={20} /><strong>No strategies yet</strong><span>Create the first reusable Direct LLM loop.</span></div>}
          <div style={{ display: "grid", gap: 8 }}>
            {strategies.map((strategy) => {
              const active = selectedId === strategy.id;
              return <button key={strategy.id} type="button" onClick={() => selectStrategy(strategy)} style={{ textAlign: "left", border: `1px solid ${active ? "var(--accent-workflow)" : "var(--color-outline-variant)"}`, background: active ? "var(--accent-workflow-soft)" : "var(--color-surface)", color: "var(--color-on-surface)", borderRadius: 8, padding: 11, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 27, height: 27, borderRadius: 7, display: "grid", placeItems: "center", background: "var(--accent-evidence-soft)", color: "var(--accent-evidence)" }}><Wand2 size={14} /></span><strong style={{ flex: 1, fontSize: 13 }}>{strategy.name}</strong><ChevronRight size={14} color="var(--color-outline)" /></div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "9px 0 0 35px" }}><span className="status-pill" style={{ color: statusColor(strategy.status) }}>{strategy.status}</span><span className="status-pill">{displayKind(strategy.kind)}</span><span className="status-pill">draft v{strategy.latestVersion?.version ?? strategy.currentVersion}</span>{strategy.latestPublishedVersion && <span className="status-pill" style={{ color: "var(--color-success)" }}>published v{strategy.latestPublishedVersion.version}</span>}</div>
              </button>;
            })}
          </div>
        </section>

        {!hasEditor ? <section className="data-panel" style={{ minHeight: 430, display: "grid", placeItems: "center", textAlign: "center" }}><div className="empty-state" style={{ maxWidth: 350 }}><Wand2 size={28} /><strong>Choose a strategy or create one</strong><span>The node editor only offers published versions. Draft here, validate it, then publish when the execution path is ready.</span><button type="button" className="btn-primary" onClick={startNew}><Plus size={15} /> Design a strategy</button></div></section> : <StrategyEditor
          name={name}
          description={description}
          definition={definition}
          step={step}
          tools={tools}
          promptProfiles={promptProfiles ?? []}
          validation={validation}
          message={message}
          saving={saving}
          estimatedCalls={estimatedCalls}
          existing={selected}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onDefinition={updateDefinition}
          onAddPhase={addPhase}
          onRemovePhase={removePhase}
          onMovePhase={movePhase}
          onStep={setStep}
          onValidate={() => void validateDefinition()}
          onSave={(publish) => void save(publish)}
        />}
      </div>
    </div>
  );
}

function StrategyEditor({
  name, description, definition, step, tools, promptProfiles, validation, message, saving, estimatedCalls, existing,
  onNameChange, onDescriptionChange, onDefinition, onAddPhase, onRemovePhase, onMovePhase, onStep, onValidate, onSave,
}: {
  name: string; description: string; definition: Definition; step: number; tools: Tool[]; promptProfiles: PromptProfile[];
  validation: { ok: boolean; failures?: Array<{ field: string; message: string }>; warnings?: string[] } | null;
  message: { tone: "success" | "error" | "info"; text: string } | null; saving: boolean; estimatedCalls: number; existing: Strategy | null;
  onNameChange: (value: string) => void; onDescriptionChange: (value: string) => void; onDefinition: (patch: Partial<Definition>) => void;
  onAddPhase: (phase: Phase) => void; onRemovePhase: (index: number) => void; onMovePhase: (index: number, direction: -1 | 1) => void;
  onStep: (step: number) => void; onValidate: () => void; onSave: (publish: boolean) => void;
}) {
  const promptOptions = useMemo(() => promptProfiles.map((profile) => ({ id: String(profile.id ?? profile.key ?? ""), label: String(profile.name ?? profile.label ?? profile.key ?? profile.id ?? "") })).filter((item) => item.id && item.label), [promptProfiles]);
  return <section className="data-panel" style={{ padding: 16 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
      <div><div className="label-xs" style={{ color: "var(--color-outline)" }}>{existing ? `Editing ${existing.status.toLowerCase()} strategy` : "New reusable strategy"}</div><h2 style={{ margin: "4px 0 0", fontSize: 20 }}>{name || "Untitled strategy"}</h2></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="status-pill"><Clock3 size={12} /> Max {estimatedCalls} provider calls</span><span className="status-pill"><ShieldCheck size={12} /> Tenant scoped</span></div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 18 }}>
      {["Choose mode", "Design path", "Converge", "Review and publish"].map((label, index) => <button type="button" key={label} onClick={() => onStep(index + 1)} style={{ border: 0, borderBottom: `2px solid ${step === index + 1 ? "var(--accent-workflow)" : "var(--color-outline-variant)"}`, background: "transparent", padding: "8px 4px", color: step === index + 1 ? "var(--accent-workflow)" : "var(--color-outline)", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{index + 1}. {label}</button>)}
    </div>

    {step === 1 && <div style={{ display: "grid", gap: 12 }}>
      <Field label="Strategy name"><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Verifier review loop" /></Field>
      <Field label="Description"><textarea value={description} onChange={(event) => onDescriptionChange(event.target.value)} rows={3} placeholder="When should this loop be used?" /></Field>
      <Field label="Loop mode"><select value={definition.kind} onChange={(event) => onDefinition({ kind: event.target.value as Kind, phaseOrder: event.target.value === "PHASE" ? (definition.phaseOrder.length ? definition.phaseOrder : ["PLAN", "VERIFY"]) : [] })}><option value="SINGLE">Single call</option><option value="PHASE">Phase loop</option><option value="TOOL">Read-only tool loop</option></select></Field>
      <div className="info-callout"><Sparkles size={15} /><span><strong>{displayKind(definition.kind)}</strong> runs through the existing Direct LLM executor. The published digest and version are recorded in the run receipt.</span></div>
    </div>}

    {step === 2 && <div style={{ display: "grid", gap: 13 }}>
      {definition.kind === "PHASE" && <>
        <div><div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 8 }}>Visual phase rail</div><div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>{definition.phaseOrder.map((phase, index) => <div key={`${phase}-${index}`} style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--accent-workflow)", background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)", borderRadius: 999, padding: "6px 8px", fontSize: 11, fontWeight: 800 }}><span>{index + 1}</span>{phase}<button type="button" title="Remove phase" onClick={() => onRemovePhase(index)} style={{ border: 0, background: "transparent", padding: 0, color: "inherit", cursor: "pointer" }}><Trash2 size={11} /></button></div>{index < definition.phaseOrder.length - 1 && <ChevronRight size={13} color="var(--color-outline)" />}</div>)}</div></div>
        <div style={{ display: "grid", gap: 6 }}><div className="label-xs" style={{ color: "var(--color-outline)" }}>Add a phase</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{PHASES.filter((phase) => !definition.phaseOrder.includes(phase)).map((phase) => <button type="button" key={phase} className="btn-secondary" onClick={() => onAddPhase(phase)}><Plus size={12} /> {phase}</button>)}</div></div>
        <div style={{ display: "grid", gap: 6 }}>{definition.phaseOrder.map((phase, index) => <div key={`${phase}-row`} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--color-outline-variant)", borderRadius: 7, padding: "7px 9px" }}><span style={{ minWidth: 24, color: "var(--accent-workflow)", fontWeight: 900 }}>{index + 1}</span><strong style={{ flex: 1, fontSize: 12 }}>{phase}</strong><button type="button" title="Move up" onClick={() => onMovePhase(index, -1)} disabled={index === 0} className="icon-button"><ArrowUp size={13} /></button><button type="button" title="Move down" onClick={() => onMovePhase(index, 1)} disabled={index === definition.phaseOrder.length - 1} className="icon-button"><ArrowDown size={13} /></button></div>)}</div>
      </>}
      {definition.kind === "TOOL" && <div style={{ display: "grid", gap: 8 }}><div className="label-xs" style={{ color: "var(--color-outline)" }}>Registered read-only tools</div>{tools.length === 0 && <div className="warning-callout"><Wrench size={15} /> No direct read-only tools are registered yet.</div>}{tools.map((tool) => <label key={tool.name} style={{ display: "flex", gap: 9, alignItems: "flex-start", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, background: definition.tools.includes(tool.name) ? "var(--accent-evidence-soft)" : "var(--color-surface)", cursor: "pointer" }}><input type="checkbox" checked={definition.tools.includes(tool.name)} onChange={(event) => onDefinition({ tools: event.target.checked ? [...definition.tools, tool.name] : definition.tools.filter((name) => name !== tool.name) })} /><span><strong style={{ display: "block", fontSize: 12 }}>{tool.name}</strong><span style={{ display: "block", color: "var(--color-outline)", fontSize: 11, marginTop: 3 }}>{tool.description}</span></span></label>)}</div>}
      {definition.kind === "SINGLE" && <div className="empty-state"><FlaskConical size={20} /><strong>Single call selected</strong><span>No phase or tool loop is needed. The node will still use its output contract and validation mode.</span></div>}
    </div>}

    {step === 3 && <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><Field label="Maximum turns"><input type="number" min={1} max={12} value={definition.kind === "SINGLE" ? 1 : definition.maxTurns} disabled={definition.kind === "SINGLE"} onChange={(event) => onDefinition({ maxTurns: Number(event.target.value) })} /></Field><Field label="Validation failure"><select value={definition.validationFailure} onChange={(event) => onDefinition({ validationFailure: event.target.value as FailureMode })}><option value="REPAIR">Repair and retry</option><option value="REVIEW">Pause for human review</option><option value="BLOCK">Block the node</option></select></Field></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><Field label="Agent role"><select value={definition.loopAgentRole ?? ""} onChange={(event) => onDefinition({ loopAgentRole: event.target.value || undefined })}><option value="">Use attached agent default</option>{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></Field><Field label="Prompt profile"><select value={definition.promptProfileKey ?? ""} onChange={(event) => onDefinition({ promptProfileKey: event.target.value || undefined })}><option value="">Use attached agent default</option>{promptOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></Field></div>
      <Field label="Loop stage context key"><input value={definition.loopStageKey} onChange={(event) => onDefinition({ loopStageKey: event.target.value })} placeholder="loop.stage" /></Field>
      <label style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--color-on-surface)", fontSize: 12 }}><input type="checkbox" checked={definition.earlyStop} disabled={definition.kind === "SINGLE"} onChange={(event) => onDefinition({ earlyStop: event.target.checked })} /> Stop as soon as the node output contract is valid</label>
      <Field label="Maximum repair attempts"><input type="number" min={0} max={3} value={definition.maxRepairAttempts} disabled={definition.kind === "TOOL" || definition.validationFailure !== "REPAIR"} onChange={(event) => onDefinition({ maxRepairAttempts: Number(event.target.value) })} /></Field>
      <div className="metric-strip"><div><strong>{estimatedCalls}</strong><span>maximum provider calls</span></div><div><strong>{definition.phaseOrder.length || 1}</strong><span>configured stages</span></div><div><strong>{definition.validationFailure}</strong><span>invalid-output behavior</span></div></div>
    </div>}

    {step === 4 && <div style={{ display: "grid", gap: 12 }}>
      <div className="info-callout"><ShieldCheck size={15} /><span>Published versions are immutable. Nodes must reference a published <strong>strategy id + version</strong>; missing versions fail closed before provider invocation.</span></div>
      <pre style={{ margin: 0, maxHeight: 280, overflow: "auto", padding: 12, borderRadius: 8, background: "#0f172a", color: "#dbeafe", fontSize: 11 }}>{JSON.stringify(definition, null, 2)}</pre>
      {validation?.failures?.map((failure) => <div key={`${failure.field}-${failure.message}`} className="error-state"><strong>{failure.field}</strong>: {failure.message}</div>)}
      {validation?.warnings?.map((warning) => <div key={warning} className="warning-callout">{warning}</div>)}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button type="button" className="btn-secondary" onClick={onValidate}><ShieldCheck size={14} /> Validate</button><button type="button" className="btn-secondary" onClick={() => onSave(false)} disabled={saving}><Save size={14} /> Save draft</button><button type="button" className="btn-primary" onClick={() => onSave(true)} disabled={saving}><Check size={14} /> {saving ? "Publishing..." : "Publish version"}</button></div>
    </div>}
    {message && <div className={message.tone === "error" ? "error-state" : message.tone === "success" ? "success-callout" : "info-callout"} style={{ marginTop: 14 }}>{message.text}</div>}
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--color-outline-variant)" }}><button type="button" className="btn-secondary" onClick={() => onStep(Math.max(1, step - 1))} disabled={step === 1}>Back</button>{step < 4 ? <button type="button" className="btn-primary" onClick={() => onStep(step + 1)}>Continue <ChevronRight size={14} /></button> : <span style={{ color: "var(--color-outline)", fontSize: 11, alignSelf: "center" }}>Attach the published version from a Direct LLM node.</span>}</div>
  </section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "grid", gap: 6, color: "var(--color-on-surface)", fontSize: 12, fontWeight: 750 }}><span className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</span>{children}</label>;
}
