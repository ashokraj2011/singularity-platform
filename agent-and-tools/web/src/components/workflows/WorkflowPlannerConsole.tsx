"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { shortId, valueText, workgraphFetch } from "@/lib/workgraph";
import { isWorkbenchProfile, workbenchNeoUrl } from "@/lib/workbenchLaunch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

type Priority = (typeof PRIORITIES)[number];

type Capability = {
  id: string;
  name: string;
  capabilityType?: string | null;
  status?: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type PlannerTask = {
  title: string;
  description: string;
  category: string;
  capabilityId: string;
  priority: Priority;
  effortDays: number;
  aiSuggested: boolean;
  rationale?: string;
};

type Milestone = {
  id: string;
  title: string;
  summary: string;
  tasks: PlannerTask[];
};

type CriticIssue = {
  dimension: string;
  itemRef: string;
  message: string;
  fix?: string;
};

type ConverseResult = {
  reply: string;
  needsClarification: boolean;
  questions: string[];
  milestones: Milestone[];
  assignableCapabilities: Array<{ id: string; name: string }>;
  homeCapabilityId: string;
  deterministic: {
    repairedAssignments: number;
    duplicatePairs: Array<{ a: number; b: number; score: number }>;
    coverageGaps: string[];
  };
  critic: { verdict: "pass" | "warn" | "fail"; issues: CriticIssue[] } | null;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number; calls: number };
  parseError?: string;
  raw?: string;
};

type CommitResult = {
  created: Array<{ id: string; workCode: string; capabilityId: string; milestone: string }>;
  failed: Array<{ title: string; error: string }>;
};

type LaunchResult = {
  intent?: { id?: string; label?: string };
  workItems: CommitResult["created"];
  failedWorkItems: CommitResult["failed"];
  workflowTemplate?: { id?: string; name?: string; workflowTypeKey?: string; profile?: string | null } | null;
  workflowInstance?: { id?: string; name?: string; status?: string } | null;
  runUrl?: string | null;
  workItemsUrl?: string | null;
  warnings?: string[];
  runtime?: { modelAlias?: string; runtimePreference?: string; governancePreset?: string };
};

const starterStory = [
  "As a product owner, I want a governed agentic SDLC flow that can:",
  "- ingest a story and split it into implementation workitems",
  "- route workitems to the right capability or team",
  "- run design, coding, testing, and approval workflows",
  "- publish artifacts, receipts, and metrics back to the platform",
].join("\n");

export function WorkflowPlannerConsole() {
  const { data: capabilityRows = [], error: capabilityError, isLoading: capabilitiesLoading, mutate: reloadCapabilities } = useSWR(
    "workflow-planner-capabilities",
    () => runtimeApi.listCapabilities() as Promise<Record<string, unknown>[]>,
  );
  const capabilities = useMemo(() => normalizeCapabilities(capabilityRows), [capabilityRows]);

  const [capabilityId, setCapabilityId] = useState("");
  const [story, setStory] = useState(starterStory);
  const [allowChildren, setAllowChildren] = useState(true);
  const [maxItems, setMaxItems] = useState(12);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [last, setLast] = useState<ConverseResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);

  useEffect(() => {
    if (!capabilityId && capabilities[0]?.id) setCapabilityId(capabilities[0].id);
  }, [capabilityId, capabilities]);

  const selectedCapability = capabilities.find((capability) => capability.id === capabilityId) ?? null;
  const validCapability = UUID_RE.test(capabilityId.trim());
  const taskCount = milestones.reduce((count, milestone) => count + milestone.tasks.length, 0);
  const totalEffort = milestones.reduce((sum, milestone) => sum + milestone.tasks.reduce((inner, task) => inner + (Number(task.effortDays) || 0), 0), 0);
  const launchWorkbenchUrl = launchResult?.workflowInstance?.id && isWorkbenchProfile(launchResult.workflowTemplate?.profile)
    ? workbenchNeoUrl({
        workflowInstanceId: launchResult.workflowInstance.id,
        browserRunId: launchResult.workflowInstance.id,
        goal: story.trim() || starterStory,
        capabilityId: capabilityId.trim(),
      })
    : null;
  const assignableCapabilities = useMemo(
    () => normalizeAssignable(last?.assignableCapabilities, selectedCapability, capabilityId),
    [last?.assignableCapabilities, selectedCapability, capabilityId],
  );
  const canPlan = validCapability && story.trim().length >= 8 && !planning;
  const canCommit = validCapability && taskCount > 0 && !committing;
  const canLaunch = validCapability && (taskCount > 0 || story.trim().length >= 8) && !launching;

  async function splitStory() {
    const text = story.trim();
    if (!validCapability) {
      setError("Choose or paste a valid capability UUID before planning.");
      return;
    }
    if (text.length < 8) {
      setError("Add a story, goal, or refinement before planning.");
      return;
    }

    setPlanning(true);
    setError(null);
    setCommitResult(null);
    setLaunchResult(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    try {
      const result = await workgraphFetch<ConverseResult>("/planner/converse", {
        method: "POST",
        body: JSON.stringify({
          capabilityId: capabilityId.trim(),
          messages: nextMessages,
          plan: milestones,
          allowChildren,
          maxItems,
        }),
      });
      setLast(result);
      setMessages([...nextMessages, { role: "assistant", content: result.reply || "Plan updated." }]);
      if (result.milestones?.length) setMilestones(normalizeMilestones(result.milestones, capabilityId));
      setStory("");
    } catch (err) {
      setError(`Planner API failed: ${errorText(err)}. You can still create a local draft from the story and commit it as WorkItems.`);
    } finally {
      setPlanning(false);
    }
  }

  function createLocalDraft() {
    if (!validCapability) {
      setError("Choose or paste a valid capability UUID before creating a draft.");
      return;
    }
    const text = story.trim();
    if (text.length < 8) {
      setError("Add a story or bullet list first.");
      return;
    }
    const draft = buildLocalDraft(text, capabilityId.trim(), maxItems);
    setMilestones(draft);
    setLast({
      reply: "Created a local draft from the story. Review the tasks, then create WorkItems.",
      needsClarification: false,
      questions: [],
      milestones: draft,
      assignableCapabilities,
      homeCapabilityId: capabilityId.trim(),
      deterministic: { repairedAssignments: 0, duplicatePairs: [], coverageGaps: [] },
      critic: { verdict: "warn", issues: [{ dimension: "source", itemRef: "plan", message: "This draft was split locally because the planner API was not used.", fix: "Review sizing and acceptance details before committing." }] },
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, calls: 0 },
    });
    setMessages([{ role: "user", content: text }, { role: "assistant", content: "Created a local draft from the story." }]);
    setCommitResult(null);
    setLaunchResult(null);
    setError(null);
  }

  async function commitPlan() {
    const prepared = sanitizeForCommit(milestones, capabilityId.trim());
    const count = prepared.reduce((sum, milestone) => sum + milestone.tasks.length, 0);
    if (!validCapability || count === 0) {
      setError("There are no valid tasks to create.");
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const result = await workgraphFetch<CommitResult>("/planner/commit", {
        method: "POST",
        body: JSON.stringify({ capabilityId: capabilityId.trim(), milestones: prepared }),
      });
      setCommitResult({ created: result.created ?? [], failed: result.failed ?? [] });
      setLaunchResult(null);
    } catch (err) {
      setError(`Create WorkItems failed: ${errorText(err)}`);
    } finally {
      setCommitting(false);
    }
  }

  async function launchSdlc() {
    const prepared = sanitizeForCommit(milestones, capabilityId.trim());
    if (!validCapability || (prepared.length === 0 && story.trim().length < 8)) {
      setError("Create a roadmap or provide a story before launching.");
      return;
    }
    setLaunching(true);
    setError(null);
    setCommitResult(null);
    setLaunchResult(null);
    try {
      const result = await workgraphFetch<LaunchResult>("/planner/launch", {
        method: "POST",
        body: JSON.stringify({
          capabilityId: capabilityId.trim(),
          intent: "build_feature",
          story: story.trim() || messages.find((message) => message.role === "user")?.content || starterStory,
          plan: prepared.length ? prepared : undefined,
          modelAlias: "balanced",
          runtimePreference: "user_runtime",
          governancePreset: "standard",
        }),
      });
      setLaunchResult(result);
      setCommitResult({ created: result.workItems ?? [], failed: result.failedWorkItems ?? [] });
    } catch (err) {
      setError(`Launch failed: ${errorText(err)}`);
    } finally {
      setLaunching(false);
    }
  }

  function resetPlan() {
    setStory(starterStory);
    setMessages([]);
    setMilestones([]);
    setLast(null);
    setCommitResult(null);
    setLaunchResult(null);
    setError(null);
  }

  return (
    <div style={{ maxWidth: 1380 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workgraph Planner</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Story to WorkItems</h1>
            <p style={{ margin: 0, maxWidth: 820, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              Paste a story or product goal, split it into milestone-grouped tasks, then create governed WorkItems for the selected capability.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/work-items" className="btn-secondary"><ClipboardList size={15} /> WorkItems</Link>
            <Link href="/workflows/start" className="btn-secondary"><Rocket size={15} /> Guided launch</Link>
            <Link href="/workflows/templates" className="btn-secondary"><GitBranch size={15} /> Workflows</Link>
            <button className="btn-secondary" type="button" onClick={() => void reloadCapabilities()}><RefreshCw size={15} /> Capabilities</button>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="Milestones" value={milestones.length} icon={GitBranch} />
        <Metric label="WorkItems" value={taskCount} icon={ClipboardList} tone="#2563eb" />
        <Metric label="Effort" value={`${trimNumber(totalEffort)}d`} icon={Rocket} tone="#b45309" />
        <Metric label="Planner" value={last?.usage?.calls ? `${last.usage.calls} calls` : "Ready"} icon={Sparkles} tone="#368727" />
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 16, alignItems: "start" }}>
        <section className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 850, color: "var(--color-on-surface)" }}>Plan input</h2>
            <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>
              The home capability owns the roadmap. Child capabilities can receive tasks when allowed by the planner.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
            <Field label="Home capability">
              <select
                value={capabilities.some((capability) => capability.id === capabilityId) ? capabilityId : ""}
                onChange={(event) => setCapabilityId(event.target.value)}
                style={inputStyle()}
              >
                <option value="">{capabilitiesLoading ? "Loading capabilities..." : "Select capability"}</option>
                {capabilities.map((capability) => (
                  <option key={capability.id} value={capability.id}>{capability.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Capability UUID">
              <input value={capabilityId} onChange={(event) => setCapabilityId(event.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" style={inputStyle({ fontFamily: "var(--font-mono, monospace)" })} />
            </Field>
          </div>

          {selectedCapability && (
            <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 9, padding: 11, background: "var(--color-surface-container)" }}>
              <div style={{ fontSize: 13, fontWeight: 850 }}>{selectedCapability.name}</div>
              <div style={{ marginTop: 3, color: "var(--color-outline)", fontSize: 12 }}>
                {selectedCapability.capabilityType ?? "Capability"} · {selectedCapability.status ?? "active"} · {shortId(selectedCapability.id)}
              </div>
            </div>
          )}

          {capabilityError && (
            <Warning text={`Capabilities could not be loaded: ${errorText(capabilityError)}. Paste the capability UUID manually if you know it.`} />
          )}
          {!validCapability && capabilityId && <Warning text="Planner commit requires a valid UUID capability id." />}

          <Field label={milestones.length ? "Refine the plan" : "Story or product goal"}>
            <textarea
              value={story}
              onChange={(event) => setStory(event.target.value)}
              rows={12}
              placeholder="Paste a story, feature brief, or bullet list..."
              style={inputStyle({ resize: "vertical", lineHeight: 1.5 })}
            />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <Field label="Max WorkItems">
              <input type="number" min={1} max={40} value={maxItems} onChange={(event) => setMaxItems(clampNumber(event.target.value, 1, 40))} style={inputStyle()} />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--color-outline)", fontSize: 13, fontWeight: 800, paddingTop: 20 }}>
              <input type="checkbox" checked={allowChildren} onChange={(event) => setAllowChildren(event.target.checked)} />
              Route to child capabilities
            </label>
          </div>

          {error && <ErrorPanel message={error} />}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-primary" type="button" disabled={!canPlan} onClick={() => void splitStory()}>
              {planning ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
              {milestones.length ? "Refine plan" : "Split into WorkItems"}
            </button>
            <button className="btn-secondary" type="button" disabled={!validCapability || !story.trim()} onClick={createLocalDraft}>
              <Sparkles size={15} /> Local draft
            </button>
            <button className="btn-secondary" type="button" onClick={resetPlan}>Reset</button>
          </div>

          {last?.reply && (
            <section style={{ borderTop: "1px solid var(--color-outline-variant)", paddingTop: 14 }}>
              <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 6 }}>Planner response</div>
              <p style={{ margin: 0, color: "var(--color-on-surface)", fontSize: 13, lineHeight: 1.55 }}>{last.reply}</p>
              {last.needsClarification && last.questions.length > 0 && (
                <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--color-outline)", fontSize: 13, lineHeight: 1.6 }}>
                  {last.questions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              )}
            </section>
          )}
        </section>

        <section style={{ display: "grid", gap: 16 }}>
          <PlanReview
            milestones={milestones}
            assignableCapabilities={assignableCapabilities}
            critic={last?.critic ?? null}
            deterministic={last?.deterministic ?? null}
            onMilestoneChange={(index, patch) => setMilestones((current) => current.map((milestone, i) => i === index ? { ...milestone, ...patch } : milestone))}
            onTaskChange={(milestoneIndex, taskIndex, patch) => setMilestones((current) => current.map((milestone, i) => i === milestoneIndex ? { ...milestone, tasks: milestone.tasks.map((task, j) => j === taskIndex ? { ...task, ...patch } : task) } : milestone))}
            onTaskDelete={(milestoneIndex, taskIndex) => setMilestones((current) => current.map((milestone, i) => i === milestoneIndex ? { ...milestone, tasks: milestone.tasks.filter((_, j) => j !== taskIndex) } : milestone))}
            onTaskAdd={(milestoneIndex) => setMilestones((current) => current.map((milestone, i) => i === milestoneIndex ? { ...milestone, tasks: [...milestone.tasks, newTask(capabilityId.trim())] } : milestone))}
            onMilestoneAdd={() => setMilestones((current) => [...current, newMilestone(current.length + 1, capabilityId.trim())])}
            onMilestoneDelete={(milestoneIndex) => setMilestones((current) => current.filter((_, i) => i !== milestoneIndex))}
          />

          <section className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 6 }}>Commit</div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 850 }}>Create governed WorkItems</h2>
                <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>
                  Create WorkItems only, or launch the first eligible WorkItem through a seeded SDLC workflow.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-secondary" type="button" disabled={!canCommit} onClick={() => void commitPlan()}>
                  {committing ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />}
                  Create {taskCount || ""} WorkItems
                </button>
                <button className="btn-primary" type="button" disabled={!canLaunch} onClick={() => void launchSdlc()}>
                  {launching ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
                  Create + Launch
                </button>
              </div>
            </div>

            {launchResult && (
              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <SuccessPanel text={launchResult.workflowInstance?.id ? `Launched ${launchResult.intent?.label ?? "SDLC workflow"} run ${shortId(launchResult.workflowInstance.id)}.` : `Created ${launchResult.workItems?.length ?? 0} WorkItems. Workflow launch needs manual routing.`} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {launchWorkbenchUrl && <Link href={launchWorkbenchUrl} className="btn-primary"><Rocket size={14} /> Open Workbench Neo</Link>}
                  {launchResult.runUrl && <Link href={launchResult.runUrl} className={launchWorkbenchUrl ? "btn-secondary" : "btn-primary"}><Rocket size={14} /> Open run cockpit</Link>}
                  <Link href={launchResult.workItemsUrl ?? "/work-items"} className="btn-secondary"><ClipboardList size={14} /> WorkItems inbox</Link>
                  <Link href="/llm-settings" className="btn-secondary"><Sparkles size={14} /> Runtime setup</Link>
                </div>
                {launchResult.workflowTemplate && (
                  <div style={{ color: "var(--color-outline)", fontSize: 12 }}>
                    Template: <strong style={{ color: "var(--color-on-surface)" }}>{launchResult.workflowTemplate.name ?? launchResult.workflowTemplate.id}</strong>
                    {launchResult.runtime?.modelAlias ? ` · model ${launchResult.runtime.modelAlias}` : ""}
                  </div>
                )}
                {(launchResult.warnings ?? []).length > 0 && <Warning text={(launchResult.warnings ?? []).join(" ")} />}
              </div>
            )}

            {commitResult && (
              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <SuccessPanel text={`Created ${commitResult.created.length} WorkItem${commitResult.created.length === 1 ? "" : "s"}.`} />
                {commitResult.created.length > 0 && (
                  <div style={{ display: "grid", gap: 7 }}>
                    {commitResult.created.map((created) => (
                      <Link key={created.id} href="/work-items" className="card card-hover" style={{ padding: 11, textDecoration: "none", boxShadow: "none" }}>
                        <strong style={{ fontSize: 13, color: "var(--color-on-surface)" }}>{created.workCode}</strong>
                        <span style={{ marginLeft: 8, color: "var(--color-outline)", fontSize: 12 }}>{created.milestone} · {shortId(created.capabilityId)}</span>
                      </Link>
                    ))}
                  </div>
                )}
                {commitResult.failed.length > 0 && (
                  <ErrorPanel message={`${commitResult.failed.length} task(s) failed: ${commitResult.failed.map((item) => `${item.title}: ${item.error}`).join("; ")}`} />
                )}
              </div>
            )}
          </section>
        </section>
      </div>
    </div>
  );
}

function PlanReview({
  milestones,
  assignableCapabilities,
  critic,
  deterministic,
  onMilestoneChange,
  onTaskChange,
  onTaskDelete,
  onTaskAdd,
  onMilestoneAdd,
  onMilestoneDelete,
}: {
  milestones: Milestone[];
  assignableCapabilities: Array<{ id: string; name: string }>;
  critic: ConverseResult["critic"];
  deterministic: ConverseResult["deterministic"] | null;
  onMilestoneChange: (index: number, patch: Partial<Milestone>) => void;
  onTaskChange: (milestoneIndex: number, taskIndex: number, patch: Partial<PlannerTask>) => void;
  onTaskDelete: (milestoneIndex: number, taskIndex: number) => void;
  onTaskAdd: (milestoneIndex: number) => void;
  onMilestoneAdd: () => void;
  onMilestoneDelete: (milestoneIndex: number) => void;
}) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 6 }}>Roadmap</div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 850 }}>Review before commit</h2>
        </div>
        <button className="btn-secondary" type="button" onClick={onMilestoneAdd}><Plus size={14} /> Milestone</button>
      </div>

      {critic && <CriticPanel critic={critic} />}
      {deterministic && <DeterministicPanel deterministic={deterministic} />}

      {milestones.length === 0 ? (
        <EmptyPanel text="No roadmap yet. Paste a story and split it into WorkItems." />
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {milestones.map((milestone, milestoneIndex) => (
            <article key={`${milestone.id}-${milestoneIndex}`} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 10, padding: 14, background: "#fff" }}>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "start" }}>
                  <Field label={`Milestone ${milestoneIndex + 1}`}>
                    <input value={milestone.title} onChange={(event) => onMilestoneChange(milestoneIndex, { title: event.target.value })} style={inputStyle()} />
                  </Field>
                  <button className="btn-secondary text-xs" type="button" onClick={() => onMilestoneDelete(milestoneIndex)} aria-label="Delete milestone">
                    <Trash2 size={13} />
                  </button>
                </div>
                <Field label="Summary">
                  <textarea value={milestone.summary} onChange={(event) => onMilestoneChange(milestoneIndex, { summary: event.target.value })} rows={2} style={inputStyle({ resize: "vertical" })} />
                </Field>
              </div>

              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                {milestone.tasks.map((task, taskIndex) => (
                  <TaskEditor
                    key={`${milestone.id}-${taskIndex}`}
                    task={task}
                    assignableCapabilities={assignableCapabilities}
                    onChange={(patch) => onTaskChange(milestoneIndex, taskIndex, patch)}
                    onDelete={() => onTaskDelete(milestoneIndex, taskIndex)}
                  />
                ))}
                {milestone.tasks.length === 0 && <EmptyPanel text="No tasks in this milestone." compact />}
                <button className="btn-secondary text-xs" type="button" onClick={() => onTaskAdd(milestoneIndex)} style={{ justifySelf: "start" }}>
                  <Plus size={13} /> Add task
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function TaskEditor({
  task,
  assignableCapabilities,
  onChange,
  onDelete,
}: {
  task: PlannerTask;
  assignableCapabilities: Array<{ id: string; name: string }>;
  onChange: (patch: Partial<PlannerTask>) => void;
  onDelete: () => void;
}) {
  return (
    <article style={{ border: "1px solid rgba(100,116,139,0.18)", borderRadius: 9, padding: 12, background: "rgba(248,250,252,0.72)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "start" }}>
        <Field label="Task title">
          <input value={task.title} onChange={(event) => onChange({ title: event.target.value })} style={inputStyle({ fontWeight: 750 })} />
        </Field>
        <button className="btn-secondary text-xs" type="button" onClick={onDelete} aria-label="Delete task">
          <Trash2 size={13} />
        </button>
      </div>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        <Field label="Acceptance description">
          <textarea value={task.description} onChange={(event) => onChange({ description: event.target.value })} rows={3} style={inputStyle({ resize: "vertical" })} />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
          <Field label="Category">
            <input value={task.category} onChange={(event) => onChange({ category: event.target.value.toUpperCase().slice(0, 40) })} style={inputStyle()} />
          </Field>
          <Field label="Priority">
            <select value={task.priority} onChange={(event) => onChange({ priority: event.target.value as Priority })} style={inputStyle()}>
              {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </Field>
          <Field label="Effort days">
            <input type="number" min={0} max={90} step={0.5} value={task.effortDays} onChange={(event) => onChange({ effortDays: clampNumber(event.target.value, 0, 90) })} style={inputStyle()} />
          </Field>
        </div>
        <Field label="Target capability">
          <select value={task.capabilityId} onChange={(event) => onChange({ capabilityId: event.target.value })} style={inputStyle({ fontFamily: "var(--font-mono, monospace)" })}>
            {assignableCapabilities.map((capability) => (
              <option key={capability.id} value={capability.id}>{capability.name} - {shortId(capability.id)}</option>
            ))}
            {!assignableCapabilities.some((capability) => capability.id === task.capabilityId) && <option value={task.capabilityId}>{task.capabilityId}</option>}
          </select>
        </Field>
        {task.rationale && (
          <p style={{ margin: 0, color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>
            {task.rationale}
          </p>
        )}
      </div>
    </article>
  );
}

function CriticPanel({ critic }: { critic: NonNullable<ConverseResult["critic"]> }) {
  const tone = critic.verdict === "pass" ? "#15803d" : critic.verdict === "fail" ? "#b91c1c" : "#b45309";
  return (
    <section style={{ border: `1px solid ${tone}33`, background: `${tone}10`, color: tone, borderRadius: 9, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 850, fontSize: 13 }}>
        {critic.verdict === "pass" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
        Critic verdict: {critic.verdict}
      </div>
      {critic.issues.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.55 }}>
          {critic.issues.slice(0, 5).map((issue, index) => (
            <li key={`${issue.itemRef}-${index}`}>
              <strong>{issue.dimension}</strong> · {issue.itemRef}: {issue.message}{issue.fix ? ` Fix: ${issue.fix}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeterministicPanel({ deterministic }: { deterministic: ConverseResult["deterministic"] }) {
  const hasFindings = deterministic.repairedAssignments > 0 || deterministic.duplicatePairs.length > 0 || deterministic.coverageGaps.length > 0;
  if (!hasFindings) return null;
  const findings = [
    deterministic.repairedAssignments > 0 ? `${deterministic.repairedAssignments} capability assignment(s) repaired` : null,
    deterministic.duplicatePairs.length > 0 ? `${deterministic.duplicatePairs.length} possible duplicate pair(s)` : null,
    deterministic.coverageGaps.length > 0 ? `Coverage gaps: ${deterministic.coverageGaps.join(", ")}` : null,
  ].filter(Boolean);
  return <Warning text={findings.join(". ")} />;
}

function Metric({ label, value, icon: Icon, tone = "var(--color-on-surface)" }: { label: string; value: string | number; icon: typeof ClipboardList; tone?: string }) {
  return (
    <div className="card" style={{ padding: 14, boxShadow: "none", display: "flex", alignItems: "center", gap: 11 }}>
      <span style={iconBox(tone)}><Icon size={17} /></span>
      <div>
        <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 850, color: tone }}>{valueText(value)}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: "grid", gap: 6 }}><span className="label-xs">{label}</span>{children}</label>;
}

function Warning({ text }: { text: string }) {
  return (
    <section style={{ border: "1px solid rgba(180,83,9,0.28)", background: "rgba(255,251,235,0.78)", color: "#92400e", borderRadius: 9, padding: 11, fontSize: 12, lineHeight: 1.5 }}>
      {text}
    </section>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <section className="card" style={{ padding: 13, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.8)", color: "#7f1d1d", fontSize: 13, lineHeight: 1.5 }}>
      {message}
    </section>
  );
}

function SuccessPanel({ text }: { text: string }) {
  return (
    <section className="card" style={{ padding: 13, borderColor: "rgba(21,128,61,0.24)", background: "rgba(240,253,244,0.84)", color: "#166534", fontSize: 13, lineHeight: 1.5 }}>
      {text}
    </section>
  );
}

function EmptyPanel({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <section className="card" style={{ padding: compact ? 14 : 24, textAlign: "center", color: "var(--color-outline)", fontSize: 13, boxShadow: "none" }}>
      {text}
    </section>
  );
}

function inputStyle(extra: CSSProperties = {}): CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    border: "1px solid var(--color-outline-variant)",
    borderRadius: 9,
    padding: "9px 11px",
    background: "#fff",
    color: "var(--color-on-surface)",
    fontSize: 13,
    outline: "none",
    ...extra,
  };
}

function iconBox(color: string): CSSProperties {
  return {
    width: 38,
    height: 38,
    borderRadius: 9,
    display: "grid",
    placeItems: "center",
    color,
    background: `${color}12`,
    border: `1px solid ${color}22`,
    flex: "0 0 auto",
  };
}

function normalizeCapabilities(rows: Record<string, unknown>[]): Capability[] {
  const mapped = rows
    .map<Capability | null>((row) => {
      const id = stringValue(row.id ?? row.capabilityId ?? row.capability_id);
      if (!id) return null;
      return {
        id,
        name: stringValue(row.name ?? row.displayName ?? row.display_name) || id,
        capabilityType: stringValue(row.capabilityType ?? row.capability_type),
        status: stringValue(row.status),
      };
    });
  return mapped
    .filter((row): row is Capability => row !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeAssignable(
  rows: Array<{ id: string; name: string }> | undefined,
  selectedCapability: Capability | null,
  capabilityId: string,
): Array<{ id: string; name: string }> {
  const out = new Map<string, string>();
  if (selectedCapability) out.set(selectedCapability.id, selectedCapability.name);
  if (capabilityId.trim()) out.set(capabilityId.trim(), selectedCapability?.name ?? "Home capability");
  for (const row of rows ?? []) {
    if (row.id) out.set(row.id, row.name || row.id);
  }
  return Array.from(out.entries()).map(([id, name]) => ({ id, name }));
}

function normalizeMilestones(input: Milestone[], homeCapabilityId: string): Milestone[] {
  return input.map((milestone, index) => ({
    id: milestone.id || `M${index + 1}`,
    title: milestone.title || `Milestone ${index + 1}`,
    summary: milestone.summary || "",
    tasks: (milestone.tasks ?? []).map((task) => ({
      title: task.title || "Untitled task",
      description: task.description || "Define acceptance criteria and complete the work.",
      category: task.category || "GENERAL",
      capabilityId: task.capabilityId || homeCapabilityId,
      priority: PRIORITIES.includes(task.priority) ? task.priority : "MEDIUM",
      effortDays: Number(task.effortDays) || 1,
      aiSuggested: Boolean(task.aiSuggested),
      rationale: task.rationale,
    })),
  }));
}

function sanitizeForCommit(input: Milestone[], homeCapabilityId: string): Milestone[] {
  return input
    .map((milestone, index) => ({
      id: milestone.id.trim() || `M${index + 1}`,
      title: milestone.title.trim() || `Milestone ${index + 1}`,
      summary: milestone.summary.trim(),
      tasks: milestone.tasks
        .filter((task) => task.title.trim().length >= 3 && task.description.trim().length >= 3)
        .map((task) => ({
          title: task.title.trim(),
          description: task.description.trim(),
          category: task.category.trim() || "GENERAL",
          capabilityId: task.capabilityId.trim() || homeCapabilityId,
          priority: task.priority,
          effortDays: Number(task.effortDays) || 1,
          aiSuggested: task.aiSuggested,
          rationale: task.rationale?.trim() || undefined,
        })),
    }))
    .filter((milestone) => milestone.tasks.length > 0);
}

function buildLocalDraft(text: string, capabilityId: string, maxItems: number): Milestone[] {
  const lines = extractWorkLines(text);
  const source = lines.length >= 2
    ? lines
    : [
      `Clarify acceptance criteria for: ${compactText(text, 90)}`,
      `Design the workflow, data contracts, and routing for: ${compactText(text, 90)}`,
      `Implement the story and integrate it with the platform capability.`,
      `Validate the flow, publish evidence, and hand off operational metrics.`,
    ];
  const tasks = source.slice(0, maxItems).map((line, index) => ({
    title: imperativeTitle(line, index),
    description: `Complete this work for the requested story: ${line}`,
    category: inferCategory(line),
    capabilityId,
    priority: index < 2 ? "HIGH" as const : "MEDIUM" as const,
    effortDays: index < 2 ? 1 : 2,
    aiSuggested: true,
    rationale: "Derived from the submitted story text.",
  }));
  const chunks = chunk(tasks, 4);
  return chunks.map((items, index) => ({
    id: `M${index + 1}`,
    title: index === 0 ? "Shape and design" : index === chunks.length - 1 ? "Validate and release" : `Build slice ${index}`,
    summary: index === 0 ? "Clarify the work and establish the implementation shape." : "Deliver and verify a coherent slice of the story.",
    tasks: items,
  }));
}

function extractWorkLines(text: string): string[] {
  const bulletLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 8 && !/^as a\b/i.test(line));
  if (bulletLines.length >= 2) return uniqueLines(bulletLines);
  return uniqueLines(
    text
      .split(/[.;]\s+|\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 16),
  );
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(compactText(line, 160));
  }
  return out;
}

function imperativeTitle(line: string, index: number): string {
  const cleaned = compactText(line.replace(/^i want\s+/i, "").replace(/^we need\s+/i, ""), 92);
  const verb = index === 0 ? "Define" : index === 1 ? "Design" : index === 2 ? "Implement" : "Validate";
  if (/^(define|design|implement|build|create|add|validate|test|publish|route|split|run|ingest)\b/i.test(cleaned)) return sentenceCase(cleaned);
  return `${verb} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
}

function inferCategory(line: string): string {
  const value = line.toLowerCase();
  if (/(auth|permission|role|tenant|policy|govern)/.test(value)) return "GOVERNANCE";
  if (/(api|endpoint|service|backend|server)/.test(value)) return "API";
  if (/(ui|screen|page|button|form|wizard|menu)/.test(value)) return "UI";
  if (/(test|verify|quality|qa|receipt|metric)/.test(value)) return "QUALITY";
  if (/(workflow|workitem|route|planner|run)/.test(value)) return "WORKFLOW";
  return "GENERAL";
}

function newMilestone(index: number, capabilityId: string): Milestone {
  return {
    id: `M${index}`,
    title: "New milestone",
    summary: "",
    tasks: [newTask(capabilityId)],
  };
}

function newTask(capabilityId: string): PlannerTask {
  return {
    title: "New WorkItem",
    description: "Describe the work, acceptance criteria, and expected evidence.",
    category: "GENERAL",
    capabilityId,
    priority: "MEDIUM",
    effortDays: 1,
    aiSuggested: false,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function compactText(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1).trim()}...` : single;
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
