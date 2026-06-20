"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  Milestone,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  TimerReset,
} from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch, WorkgraphError } from "@/lib/workgraph";

type WorkbenchMode = "cockpit" | "theater";
type WorkbenchView = "cockpit" | "artifacts" | "code-review" | "stage-chat" | "milestones" | "export" | "audit" | "governance" | "loop-theater";
type WorkbenchSourceType = "github" | "localdir";
type WorkbenchGateMode = "manual" | "auto";

const workbenchViews: Array<{ view: WorkbenchView; href: string; label: string }> = [
  { view: "cockpit", href: "/workbench/cockpit", label: "Cockpit" },
  { view: "loop-theater", href: "/workbench/loop-theater", label: "Loop Theater" },
  { view: "artifacts", href: "/workbench/artifacts", label: "Artifacts" },
  { view: "code-review", href: "/workbench/code-review", label: "Code Review" },
  { view: "stage-chat", href: "/workbench/stage-chat", label: "Stage Chat" },
  { view: "milestones", href: "/workbench/milestones", label: "Milestones" },
  { view: "governance", href: "/workbench/governance", label: "Governance" },
  { view: "audit", href: "/workbench/audit", label: "Audit" },
  { view: "export", href: "/workbench/export", label: "Export" },
];

const viewCopy: Record<WorkbenchView, { title: string; description: string }> = {
  cockpit: {
    title: "Guided Delivery Cockpit",
    description: "Operate Blueprint Workbench sessions with stage progress, artifacts, chat, code changes, milestone state, and linked workflow runs in one native surface.",
  },
  "loop-theater": {
    title: "Loop Theater",
    description: "Replay the current stage loop with model/tool steps, phase movement, governance events, and code-change evidence.",
  },
  artifacts: {
    title: "Workbench Artifacts",
    description: "Review generated contract packs, stage outputs, consumables, and final handoff artifacts for the selected session.",
  },
  "code-review": {
    title: "Code Review",
    description: "Inspect code-change evidence, commits, touched paths, stale changes, and implementation deltas for the active stage.",
  },
  "stage-chat": {
    title: "Stage Chat",
    description: "Continue the operator-to-agent thread for the current stage and keep decisions close to the Workbench session.",
  },
  milestones: {
    title: "Milestones",
    description: "Track milestone mode progress, review events, and final pack state for larger governed delivery runs.",
  },
  governance: {
    title: "Governance",
    description: "Inspect governance checkpoints and policy events emitted by the active Workbench loop.",
  },
  audit: {
    title: "Audit Trail",
    description: "Follow the replayable stage trace and review events captured for the selected Workbench session.",
  },
  export: {
    title: "Export",
    description: "Prepare the final pack and inspect export-ready artifacts for handoff back to the workflow.",
  },
};

type BlueprintSession = {
  id: string;
  goal?: string;
  status?: string;
  sourceType?: string;
  sourceUri?: string;
  sourceRef?: string;
  capabilityId?: string;
  currentStageKey?: string | null;
  workflowInstanceId?: string | null;
  browserRunId?: string | null;
  workflowNodeId?: string | null;
  updatedAt?: string;
  createdAt?: string;
  loopDefinition?: { name?: string; stages?: LoopStage[] };
  stageAttempts?: StageAttempt[];
  reviewEvents?: ReviewEvent[];
  stageChats?: Record<string, StageChatMessage[]>;
  milestone?: MilestoneState;
  finalPack?: { id?: string; status?: string; summary?: string; generatedAt?: string; artifactKinds?: string[] };
  artifacts?: BlueprintArtifact[];
};

type LoopStage = {
  key: string;
  label?: string;
  agentRole?: string;
  description?: string;
  terminal?: boolean;
  required?: boolean;
  approvalRequired?: boolean;
  expectedArtifacts?: Array<{ kind: string; title?: string; required?: boolean; editable?: boolean }>;
  contextPolicy?: string;
  toolPolicy?: string;
  repoAccess?: boolean;
};

type StageAttempt = {
  id?: string;
  stageKey?: string;
  stageLabel?: string;
  agentRole?: string;
  attemptNumber?: number;
  status?: string;
  verdict?: string;
  confidence?: number;
  startedAt?: string;
  completedAt?: string;
  feedback?: string;
  error?: string;
  artifactIds?: string[];
  gateRecommendation?: { verdict?: string; confidence?: number; reason?: string; targetStageKey?: string };
  correlation?: { traceId?: string; cfCallId?: string; codeChangeIds?: string[]; [key: string]: unknown };
  tokensUsed?: { input?: number; output?: number; total?: number; estimatedCost?: number };
};

type ReviewEvent = {
  id?: string;
  type?: string;
  stageKey?: string;
  targetStageKey?: string;
  message?: string;
  createdAt?: string;
};

type StageChatMessage = {
  id?: string;
  role?: "operator" | "system" | "agent";
  content?: string;
  createdAt?: string;
};

type MilestoneState = {
  enabled?: boolean;
  currentMilestoneId?: string | null;
  plan?: Array<{ id: string; title?: string; subGoal?: string; status?: string }>;
  history?: Array<{ milestoneId?: string; status?: string; completedAt?: string }>;
};

type BlueprintArtifact = {
  id?: string;
  kind?: string;
  title?: string;
  content?: string;
  stage?: string;
  stageKey?: string;
  attemptId?: string;
  consumableId?: string;
  consumableStatus?: string;
  createdAt?: string;
};

type CodeChangeRecord = {
  id?: string;
  tool_name?: string;
  paths_touched?: string[];
  commit_sha?: string;
  lines_added?: number;
  lines_removed?: number;
  timestamp?: string;
  stale?: boolean;
};

type CreateWorkbenchSessionPayload = {
  goal: string;
  sourceType: WorkbenchSourceType;
  sourceUri: string;
  sourceRef?: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  capabilityId: string;
  architectAgentTemplateId?: string;
  developerAgentTemplateId?: string;
  qaAgentTemplateId?: string;
  gateMode: WorkbenchGateMode;
};

type LoopTraceResponse = {
  traceId?: string;
  phases?: Array<{ phase?: string; llmCallCount?: number; toolInvocationCount?: number; startedAt?: string; endedAt?: string }>;
  steps?: Array<{
    llmCallId?: string;
    stepIndex?: number | null;
    phase?: string | null;
    finishReason?: string;
    latencyMs?: number;
    timestamp?: string;
    responseText?: string | null;
    responseToolCalls?: Array<{ name?: string; args_preview?: string }>;
    toolInvocations?: Array<{ id?: string; name?: string; success?: boolean; timestamp?: string; error?: string | null }>;
  }>;
  governanceEvents?: Array<{ kind?: string; phase?: string | null; timestamp?: string; details?: Record<string, unknown> }>;
  summary?: { totalSteps?: number; totalLlmCalls?: number; totalToolInvocations?: number; totalCodeChanges?: number; finishReason?: string | null };
};

const stageStatusTone: Record<string, string> = {
  RUNNING: "#2563eb",
  COMPLETED: "#15803d",
  PASSED: "#15803d",
  PASS: "#15803d",
  ACCEPTED_WITH_RISK: "#b45309",
  NEEDS_REWORK: "#b45309",
  BLOCKED: "#b91c1c",
  FAILED: "#b91c1c",
  PAUSED: "#7c3aed",
  PENDING: "#64748b",
};

function latestAttemptFor(session: BlueprintSession | undefined, stageKey: string): StageAttempt | undefined {
  return [...(session?.stageAttempts ?? [])]
    .filter((attempt) => attempt.stageKey === stageKey)
    .sort((a, b) => Number(b.attemptNumber ?? 0) - Number(a.attemptNumber ?? 0))[0];
}

function currentStage(session: BlueprintSession | undefined): LoopStage | undefined {
  const key = session?.currentStageKey;
  if (!key) return undefined;
  return session?.loopDefinition?.stages?.find((stage) => stage.key === key);
}

function actionButtonStyle(disabled?: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 38,
    borderRadius: 8,
    border: "1px solid var(--color-outline-variant)",
    background: disabled ? "#f8fafc" : "#fff",
    color: disabled ? "#94a3b8" : "var(--color-text)",
    padding: "8px 12px",
    fontWeight: 750,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

async function fetchSessions(): Promise<BlueprintSession[]> {
  return unwrapWorkgraphItems<BlueprintSession>(await workgraphFetch("/blueprint/sessions"), ["sessions"]);
}

async function fetchSession(id: string): Promise<BlueprintSession> {
  return workgraphFetch(`/blueprint/sessions/${encodeURIComponent(id)}`);
}

// Key is a namespaced 3-tuple [ns, sessionId, stageKey] — the leading namespace
// keeps these two fetchers' SWR cache entries distinct (see the useSWR calls).
async function fetchCodeChanges(input: [string, string, string | undefined]): Promise<CodeChangeRecord[]> {
  const [, sessionId, stageKey] = input;
  const qs = stageKey ? `?stageKey=${encodeURIComponent(stageKey)}` : "";
  return unwrapWorkgraphItems<CodeChangeRecord>(await workgraphFetch(`/blueprint/sessions/${encodeURIComponent(sessionId)}/code-changes${qs}`), ["items"]);
}

async function fetchLoopTrace(input: [string, string, string | undefined]): Promise<LoopTraceResponse | null> {
  const [, sessionId, stageKey] = input;
  if (!stageKey) return null;
  return workgraphFetch(`/blueprint/sessions/${encodeURIComponent(sessionId)}/stages/${encodeURIComponent(stageKey)}/loop-trace`);
}

async function createWorkbenchSession(payload: CreateWorkbenchSessionPayload): Promise<BlueprintSession> {
  return workgraphFetch("/blueprint/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function WorkbenchConsole({ mode = "cockpit", view }: { mode?: WorkbenchMode; view?: WorkbenchView }) {
  const router = useRouter();
  const search = useSearchParams();
  const activeView = view ?? (mode === "theater" ? "loop-theater" : "cockpit");
  const copy = viewCopy[activeView];
  const explicitSessionId = search.get("sessionId") ?? undefined;
  const { data: sessions = [], error: sessionsError, isLoading: loadingSessions, mutate: reloadSessions } = useSWR("blueprint-sessions", fetchSessions, { refreshInterval: 12000 });
  const selectedId = explicitSessionId ?? sessions[0]?.id;
  const { data: session, error: sessionError, isLoading: loadingSession, mutate: reloadSession } = useSWR(selectedId ? ["blueprint-session", selectedId] : null, () => fetchSession(selectedId as string), { refreshInterval: 8000 });
  const activeStage = currentStage(session);
  const activeStageKey = session?.currentStageKey ?? activeStage?.key;
  const { data: codeChanges = [], error: codeError, mutate: reloadCode } = useSWR(session?.id ? ["wb-code-changes", session.id, activeStageKey] : null, fetchCodeChanges, { refreshInterval: 15000 });
  const { data: loopTrace, error: traceError, mutate: reloadTrace } = useSWR(session?.id && activeStageKey ? ["wb-loop-trace", session.id, activeStageKey] : null, fetchLoopTrace, { refreshInterval: mode === "theater" ? 5000 : 12000 });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createGoal, setCreateGoal] = useState("");
  const [createSourceType, setCreateSourceType] = useState<WorkbenchSourceType>("github");
  const [createSourceUri, setCreateSourceUri] = useState("");
  const [createSourceRef, setCreateSourceRef] = useState("");
  const [createCapabilityId, setCreateCapabilityId] = useState("");
  const [createGateMode, setCreateGateMode] = useState<WorkbenchGateMode>("manual");
  const [architectAgentTemplateId, setArchitectAgentTemplateId] = useState("");
  const [developerAgentTemplateId, setDeveloperAgentTemplateId] = useState("");
  const [qaAgentTemplateId, setQaAgentTemplateId] = useState("");

  const stages = session?.loopDefinition?.stages ?? [];
  const attemptsByStage = useMemo(() => new Map(stages.map((stage) => [stage.key, latestAttemptFor(session, stage.key)])), [session, stages]);
  const artifacts = session?.artifacts ?? [];
  const activeMessages = activeStageKey ? session?.stageChats?.[activeStageKey] ?? [] : [];

  function selectSession(id: string) {
    const next = new URLSearchParams(search.toString());
    next.set("sessionId", id);
    router.push(`?${next.toString()}`);
  }

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setBusyAction(label);
    setActionError(null);
    try {
      await fn();
      await Promise.all([reloadSession(), reloadSessions(), reloadCode(), reloadTrace()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function submitCreateSession() {
    const goal = createGoal.trim();
    const sourceUri = createSourceUri.trim();
    const capabilityId = createCapabilityId.trim();
    if (goal.length < 8 || !sourceUri || !capabilityId) {
      setActionError("Goal, source, and capability id are required. Goal must be at least 8 characters.");
      return;
    }

    setBusyAction("create-session");
    setActionError(null);
    try {
      const created = await createWorkbenchSession({
        goal,
        sourceType: createSourceType,
        sourceUri,
        sourceRef: createSourceRef.trim() || undefined,
        includeGlobs: [],
        excludeGlobs: [],
        capabilityId,
        architectAgentTemplateId: architectAgentTemplateId.trim() || undefined,
        developerAgentTemplateId: developerAgentTemplateId.trim() || undefined,
        qaAgentTemplateId: qaAgentTemplateId.trim() || undefined,
        gateMode: createGateMode,
      });
      setCreateOpen(false);
      setCreateGoal("");
      setCreateSourceUri("");
      setCreateSourceRef("");
      setCreateCapabilityId("");
      setArchitectAgentTemplateId("");
      setDeveloperAgentTemplateId("");
      setQaAgentTemplateId("");
      await reloadSessions();
      router.push(`?sessionId=${encodeURIComponent(created.id ?? "")}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  const topError = sessionsError ?? sessionError;

  return (
    <div style={{ maxWidth: 1440 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <Link href="/workflows/templates" className="btn-secondary">
          <ArrowLeft size={15} />
          Back to workflows
        </Link>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {session?.workflowInstanceId && (
            <Link href={`/runs/${encodeURIComponent(session.workflowInstanceId)}`} className="btn-secondary">
              <GitBranch size={15} />
              Workflow run
            </Link>
          )}
          <button type="button" style={actionButtonStyle()} onClick={() => void Promise.all([reloadSessions(), reloadSession(), reloadCode(), reloadTrace()])}>
            <RefreshCw size={15} />
            Refresh
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreateOpen((open) => !open)}>
            <Sparkles size={15} />
            Create session
          </button>
        </div>
      </div>

      {createOpen || (!loadingSessions && sessions.length === 0) ? (
        <CreateSessionPanel
          goal={createGoal}
          setGoal={setCreateGoal}
          sourceType={createSourceType}
          setSourceType={setCreateSourceType}
          sourceUri={createSourceUri}
          setSourceUri={setCreateSourceUri}
          sourceRef={createSourceRef}
          setSourceRef={setCreateSourceRef}
          capabilityId={createCapabilityId}
          setCapabilityId={setCreateCapabilityId}
          gateMode={createGateMode}
          setGateMode={setCreateGateMode}
          architectAgentTemplateId={architectAgentTemplateId}
          setArchitectAgentTemplateId={setArchitectAgentTemplateId}
          developerAgentTemplateId={developerAgentTemplateId}
          setDeveloperAgentTemplateId={setDeveloperAgentTemplateId}
          qaAgentTemplateId={qaAgentTemplateId}
          setQaAgentTemplateId={setQaAgentTemplateId}
          busy={busyAction === "create-session"}
          onSubmit={submitCreateSession}
        />
      ) : null}

      <section className="card" style={{ padding: 22, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", letterSpacing: 0, marginBottom: 10 }}>
              <Sparkles size={15} />
              Blueprint Workbench
            </div>
            <h1 className="page-header" style={{ margin: 0 }}>{copy.title}</h1>
            <p style={{ maxWidth: 820, color: "var(--color-outline)", lineHeight: 1.55, fontSize: 14, margin: "10px 0 0" }}>
              {copy.description}
            </p>
          </div>
          <div style={{ minWidth: 240, display: "grid", gridTemplateColumns: "repeat(2, minmax(100px, 1fr))", gap: 8 }}>
            <Metric label="Sessions" value={sessions.length || (loadingSessions ? "..." : 0)} />
            <Metric label="Status" value={session?.status ?? "-"} tone={stageStatusTone[session?.status ?? ""]} />
            <Metric label="Stage" value={activeStage?.label ?? activeStageKey ?? "-"} />
            <Metric label="Artifacts" value={artifacts.length} />
          </div>
        </div>
      </section>

      {topError ? <WorkbenchError error={topError} /> : null}
      {actionError ? (
        <section className="card" style={{ padding: 14, marginBottom: 18, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)", color: "#7f1d1d", fontSize: 13 }}>
          {actionError}
        </section>
      ) : null}

      <WorkbenchNav activeView={activeView} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(250px, 320px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <aside className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Sessions</h2>
            <span style={{ fontSize: 12, color: "var(--color-outline)" }}>{loadingSessions ? "Loading" : `${sessions.length} total`}</span>
          </div>
          <div style={{ display: "grid", gap: 8, maxHeight: 620, overflow: "auto", paddingRight: 4 }}>
            {sessions.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectSession(item.id)}
                style={{
                  textAlign: "left",
                  border: item.id === selectedId ? "1px solid rgba(0,132,61,0.42)" : "1px solid var(--color-outline-variant)",
                  background: item.id === selectedId ? "rgba(240,253,244,0.86)" : "#fff",
                  borderRadius: 8,
                  padding: 12,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <strong style={{ fontSize: 13, lineHeight: 1.3 }}>{item.goal || shortId(item.id)}</strong>
                  <StatusPill value={item.status} />
                </div>
                <div style={{ fontSize: 12, color: "var(--color-outline)", lineHeight: 1.5 }}>
                  <div>{item.currentStageKey ? `Stage ${item.currentStageKey}` : "No active stage"}</div>
                  <div>{formatDate(item.updatedAt ?? item.createdAt)}</div>
                </div>
              </button>
            ))}
            {!loadingSessions && sessions.length === 0 && <EmptyPanel label="No Workbench sessions found." />}
          </div>
        </aside>

        <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {loadingSession && !session ? <LoadingCard /> : session ? (
            <>
              <SessionOverview session={session} activeStage={activeStage} />
              <ActionStrip
                session={session}
                activeStageKey={activeStageKey}
                busyAction={busyAction}
                onAction={runAction}
              />
              <WorkbenchFocus
                view={activeView}
                session={session}
                stages={stages}
                attemptsByStage={attemptsByStage}
                artifacts={artifacts}
                codeChanges={codeChanges}
                codeError={codeError}
                trace={loopTrace}
                traceError={traceError}
                activeStageKey={activeStageKey}
                activeMessages={activeMessages}
                chatDraft={chatDraft}
                setChatDraft={setChatDraft}
                busyAction={busyAction}
                onAction={runAction}
              />
            </>
          ) : (
            <EmptyPanel label="Select a Workbench session to begin." />
          )}
        </main>
      </div>
    </div>
  );
}

function CreateSessionPanel({
  goal,
  setGoal,
  sourceType,
  setSourceType,
  sourceUri,
  setSourceUri,
  sourceRef,
  setSourceRef,
  capabilityId,
  setCapabilityId,
  gateMode,
  setGateMode,
  architectAgentTemplateId,
  setArchitectAgentTemplateId,
  developerAgentTemplateId,
  setDeveloperAgentTemplateId,
  qaAgentTemplateId,
  setQaAgentTemplateId,
  busy,
  onSubmit,
}: {
  goal: string;
  setGoal: (value: string) => void;
  sourceType: WorkbenchSourceType;
  setSourceType: (value: WorkbenchSourceType) => void;
  sourceUri: string;
  setSourceUri: (value: string) => void;
  sourceRef: string;
  setSourceRef: (value: string) => void;
  capabilityId: string;
  setCapabilityId: (value: string) => void;
  gateMode: WorkbenchGateMode;
  setGateMode: (value: WorkbenchGateMode) => void;
  architectAgentTemplateId: string;
  setArchitectAgentTemplateId: (value: string) => void;
  developerAgentTemplateId: string;
  setDeveloperAgentTemplateId: (value: string) => void;
  qaAgentTemplateId: string;
  setQaAgentTemplateId: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  const fieldStyle: CSSProperties = {
    width: "100%",
    minHeight: 38,
    border: "1px solid var(--color-outline-variant)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 13,
    color: "var(--color-on-surface)",
    background: "#fff",
  };
  const labelStyle: CSSProperties = {
    display: "grid",
    gap: 6,
    fontSize: 12,
    fontWeight: 850,
    color: "var(--color-outline)",
    textTransform: "uppercase",
    letterSpacing: 0,
  };

  return (
    <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(0,132,61,0.28)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Bot size={18} color="var(--color-primary)" />
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Create Workbench Session</h2>
            <p style={{ margin: "4px 0 0", color: "var(--color-outline)", fontSize: 13 }}>Start a guided delivery loop from a repo, local path, and capability owner.</p>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={onSubmit}
        >
          <Sparkles size={15} />
          {busy ? "Creating..." : "Create"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, alignItems: "start" }}>
        <label style={labelStyle}>
          Goal
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={4}
            placeholder="Describe the delivery outcome, constraints, acceptance criteria, and expected handoff."
            style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.45 }}
          />
        </label>
        <div style={{ display: "grid", gap: 10 }}>
          <label style={labelStyle}>
            Capability ID
            <input value={capabilityId} onChange={(event) => setCapabilityId(event.target.value)} placeholder="capability id" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Gate Mode
            <select value={gateMode} onChange={(event) => setGateMode(event.target.value as WorkbenchGateMode)} style={fieldStyle}>
              <option value="manual">manual</option>
              <option value="auto">auto</option>
            </select>
          </label>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
        <label style={labelStyle}>
          Source
          <select value={sourceType} onChange={(event) => setSourceType(event.target.value as WorkbenchSourceType)} style={fieldStyle}>
            <option value="github">github</option>
            <option value="localdir">localdir</option>
          </select>
        </label>
        <label style={labelStyle}>
          Source URI
          <input value={sourceUri} onChange={(event) => setSourceUri(event.target.value)} placeholder={sourceType === "github" ? "https://github.com/org/repo" : "/absolute/path/to/repo"} style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Branch / Ref
          <input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="main" style={fieldStyle} />
        </label>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--color-outline)", fontSize: 13, fontWeight: 800 }}>Agent template overrides</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 10 }}>
          <label style={labelStyle}>
            Architect
            <input value={architectAgentTemplateId} onChange={(event) => setArchitectAgentTemplateId(event.target.value)} placeholder="optional uuid" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Developer
            <input value={developerAgentTemplateId} onChange={(event) => setDeveloperAgentTemplateId(event.target.value)} placeholder="optional uuid" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            QA
            <input value={qaAgentTemplateId} onChange={(event) => setQaAgentTemplateId(event.target.value)} placeholder="optional uuid" style={fieldStyle} />
          </label>
        </div>
      </details>
    </section>
  );
}

function WorkbenchNav({ activeView }: { activeView: WorkbenchView }) {
  return (
    <nav className="card" style={{ padding: 8, marginBottom: 18, display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Workbench sections">
      {workbenchViews.map((item) => {
        const active = item.view === activeView;
        return (
          <Link
            key={item.view}
            href={item.href}
            style={{
              border: active ? "1px solid rgba(0,132,61,0.42)" : "1px solid transparent",
              background: active ? "rgba(240,253,244,0.88)" : "transparent",
              color: active ? "var(--color-primary)" : "var(--color-outline)",
              borderRadius: 8,
              padding: "8px 11px",
              fontWeight: 850,
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function WorkbenchFocus({
  view,
  session,
  stages,
  attemptsByStage,
  artifacts,
  codeChanges,
  codeError,
  trace,
  traceError,
  activeStageKey,
  activeMessages,
  chatDraft,
  setChatDraft,
  busyAction,
  onAction,
}: {
  view: WorkbenchView;
  session: BlueprintSession;
  stages: LoopStage[];
  attemptsByStage: Map<string, StageAttempt | undefined>;
  artifacts: BlueprintArtifact[];
  codeChanges: CodeChangeRecord[];
  codeError?: unknown;
  trace?: LoopTraceResponse | null;
  traceError?: unknown;
  activeStageKey?: string | null;
  activeMessages: StageChatMessage[];
  chatDraft: string;
  setChatDraft: (value: string) => void;
  busyAction: string | null;
  onAction: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const chatPanel = (
    <StageChatPanel
      sessionId={session.id}
      stageKey={activeStageKey}
      messages={activeMessages}
      draft={chatDraft}
      setDraft={setChatDraft}
      busy={busyAction === "stage-chat"}
      onSend={(content) => onAction("stage-chat", () => workgraphFetch(`/blueprint/sessions/${encodeURIComponent(session.id)}/stages/${encodeURIComponent(activeStageKey ?? "")}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "operator", content }),
      }))}
    />
  );

  if (view === "artifacts") {
    return (
      <>
        <ArtifactsPanel artifacts={artifacts} />
        <ExportPanel session={session} artifacts={artifacts} />
      </>
    );
  }

  if (view === "code-review") {
    return (
      <>
        <CodeChangesPanel changes={codeChanges} error={codeError} />
        <LoopTracePanel trace={trace} traceError={traceError} activeStageKey={activeStageKey} compact />
      </>
    );
  }

  if (view === "stage-chat") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.9fr)", gap: 16, alignItems: "start" }}>
        {chatPanel}
        <EventsPanel events={session.reviewEvents ?? []} milestone={session.milestone} finalPack={session.finalPack} />
      </div>
    );
  }

  if (view === "milestones") {
    return (
      <>
        <EventsPanel events={session.reviewEvents ?? []} milestone={session.milestone} finalPack={session.finalPack} />
        <StageRail session={session} stages={stages} attemptsByStage={attemptsByStage} />
      </>
    );
  }

  if (view === "governance" || view === "audit" || view === "loop-theater") {
    return (
      <>
        <LoopTracePanel trace={trace} traceError={traceError} activeStageKey={activeStageKey} />
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.9fr)", gap: 16, alignItems: "start" }}>
          <CodeChangesPanel changes={codeChanges} error={codeError} />
          <EventsPanel events={session.reviewEvents ?? []} milestone={session.milestone} finalPack={session.finalPack} />
        </div>
      </>
    );
  }

  if (view === "export") {
    return (
      <>
        <ExportPanel session={session} artifacts={artifacts} />
        <ArtifactsPanel artifacts={artifacts} />
      </>
    );
  }

  return (
    <>
      <StageRail session={session} stages={stages} attemptsByStage={attemptsByStage} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(320px, 0.85fr)", gap: 16, alignItems: "start" }}>
        <ArtifactsPanel artifacts={artifacts} />
        <CodeChangesPanel changes={codeChanges} error={codeError} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.9fr)", gap: 16, alignItems: "start" }}>
        {chatPanel}
        <EventsPanel events={session.reviewEvents ?? []} milestone={session.milestone} finalPack={session.finalPack} />
      </div>
      <LoopTracePanel trace={trace} traceError={traceError} activeStageKey={activeStageKey} compact />
    </>
  );
}

function SessionOverview({ session, activeStage }: { session: BlueprintSession; activeStage?: LoopStage }) {
  return (
    <section className="card" style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <StatusPill value={session.status} />
            <span style={{ fontSize: 12, color: "var(--color-outline)" }}>{shortId(session.id)}</span>
            {session.workflowInstanceId && <span style={{ fontSize: 12, color: "var(--color-outline)" }}>run {shortId(session.workflowInstanceId)}</span>}
          </div>
          <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25 }}>{session.goal || "Untitled Workbench session"}</h2>
          <p style={{ margin: "10px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.55 }}>
            {activeStage?.description || `Current stage: ${activeStage?.label ?? session.currentStageKey ?? "not started"}`}
          </p>
        </div>
        <div style={{ minWidth: 280, display: "grid", gridTemplateColumns: "repeat(2, minmax(120px, 1fr))", gap: 8 }}>
          <Fact label="Capability" value={session.capabilityId} />
          <Fact label="Source" value={session.sourceType} />
          <Fact label="Branch/ref" value={session.sourceRef} />
          <Fact label="Updated" value={formatDate(session.updatedAt ?? session.createdAt)} />
        </div>
      </div>
    </section>
  );
}

function ActionStrip({
  session,
  activeStageKey,
  busyAction,
  onAction,
}: {
  session: BlueprintSession;
  activeStageKey?: string | null;
  busyAction: string | null;
  onAction: (label: string, fn: () => Promise<unknown>) => void;
}) {
  const disabled = Boolean(busyAction);
  return (
    <section className="card" style={{ padding: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button type="button" style={actionButtonStyle(disabled)} disabled={disabled} onClick={() => onAction("snapshot", () => workgraphFetch(`/blueprint/sessions/${encodeURIComponent(session.id)}/snapshot`, { method: "POST" }))}>
        <TimerReset size={15} />
        Snapshot
      </button>
      <button
        type="button"
        style={actionButtonStyle(disabled || !activeStageKey)}
        disabled={disabled || !activeStageKey}
        onClick={() => onAction("run-stage", () => workgraphFetch(`/blueprint/sessions/${encodeURIComponent(session.id)}/stages/${encodeURIComponent(activeStageKey ?? "")}/run`, { method: "POST" }))}
      >
        <Play size={15} />
        Run stage
      </button>
      <button type="button" style={actionButtonStyle(disabled)} disabled={disabled} onClick={() => onAction("finalize", () => workgraphFetch(`/blueprint/sessions/${encodeURIComponent(session.id)}/finalize`, { method: "POST" }))}>
        <CheckCircle2 size={15} />
        Finalize
      </button>
      <button type="button" style={actionButtonStyle(disabled)} disabled={disabled} onClick={() => onAction("approve", () => workgraphFetch(`/blueprint/sessions/${encodeURIComponent(session.id)}/approve`, { method: "POST" }))}>
        <CheckCircle2 size={15} />
        Approve
      </button>
      {busyAction && <span style={{ color: "var(--color-outline)", fontSize: 12 }}>Running {busyAction}...</span>}
    </section>
  );
}

function StageRail({ session, stages, attemptsByStage }: { session: BlueprintSession; stages: LoopStage[]; attemptsByStage: Map<string, StageAttempt | undefined> }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Stage Rail</h2>
        <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{session.loopDefinition?.name ?? "Loop definition"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
        {stages.map((stage) => {
          const attempt = attemptsByStage.get(stage.key);
          const active = stage.key === session.currentStageKey;
          const tone = stageStatusTone[attempt?.status ?? ""] ?? (active ? "#2563eb" : "#64748b");
          return (
            <article key={stage.key} style={{ border: active ? "1px solid rgba(37,99,235,0.42)" : "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12, background: active ? "rgba(239,246,255,0.82)" : "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{stage.label ?? stage.key}</strong>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: tone }} />
              </div>
              <div style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--color-outline)" }}>
                <span>{stage.agentRole ?? "stage agent"}</span>
                <span>{attempt ? `Attempt ${attempt.attemptNumber ?? "-"} · ${attempt.status ?? "-"}` : "No attempt yet"}</span>
                <span>{attempt?.verdict ? `Verdict ${attempt.verdict}` : `${stage.toolPolicy ?? "tool policy n/a"} · ${stage.contextPolicy ?? "context n/a"}`}</span>
                {attempt?.gateRecommendation?.reason && <span style={{ color: "#92400e" }}>{attempt.gateRecommendation.reason}</span>}
              </div>
            </article>
          );
        })}
        {stages.length === 0 && <EmptyPanel label="This session has no loop stages." />}
      </div>
    </section>
  );
}

function ArtifactsPanel({ artifacts }: { artifacts: BlueprintArtifact[] }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Artifacts</h2>
      <div style={{ display: "grid", gap: 10, maxHeight: 430, overflow: "auto", paddingRight: 4 }}>
        {artifacts.map((artifact) => (
          <article key={artifact.id ?? `${artifact.kind}-${artifact.createdAt}`} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>{artifact.title ?? artifact.kind ?? "Artifact"}</strong>
              <FileCode2 size={15} color="var(--color-primary)" />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "var(--color-outline)", fontSize: 12 }}>
              <span>{artifact.kind}</span>
              <span>{artifact.stageKey ?? artifact.stage}</span>
              {artifact.consumableStatus && <span>{artifact.consumableStatus}</span>}
              <span>{formatDate(artifact.createdAt)}</span>
            </div>
            {artifact.content && <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--color-text)" }}>{artifact.content.slice(0, 260)}</p>}
          </article>
        ))}
        {artifacts.length === 0 && <EmptyPanel label="No artifacts have been generated yet." />}
      </div>
    </section>
  );
}

function CodeChangesPanel({ changes, error }: { changes: CodeChangeRecord[]; error?: unknown }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Code Changes</h2>
      {error ? <SmallError error={error} /> : null}
      <div style={{ display: "grid", gap: 10, maxHeight: 430, overflow: "auto", paddingRight: 4 }}>
        {changes.map((change) => (
          <article key={change.id ?? change.commit_sha ?? change.timestamp} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <GitPullRequest size={15} color="var(--color-primary)" />
              <strong style={{ fontSize: 13 }}>{change.commit_sha ? shortId(change.commit_sha) : change.tool_name ?? "Change"}</strong>
              {change.stale && <span style={{ color: "#b45309", fontSize: 12 }}>stale</span>}
            </div>
            <div style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.55 }}>
              <div>{(change.paths_touched ?? []).slice(0, 4).join(", ") || "No paths reported"}</div>
              <div>{Number(change.lines_added ?? 0)} added · {Number(change.lines_removed ?? 0)} removed · {formatDate(change.timestamp)}</div>
            </div>
          </article>
        ))}
        {changes.length === 0 && !error && <EmptyPanel label="No code changes reported for this stage." />}
      </div>
    </section>
  );
}

function StageChatPanel({
  sessionId,
  stageKey,
  messages,
  draft,
  setDraft,
  busy,
  onSend,
}: {
  sessionId: string;
  stageKey?: string | null;
  messages: StageChatMessage[];
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  onSend: (content: string) => void;
}) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <MessageSquare size={16} color="var(--color-primary)" />
        <h2 style={{ margin: 0, fontSize: 16 }}>Stage Chat</h2>
        <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{stageKey ?? "no stage"}</span>
      </div>
      <div style={{ display: "grid", gap: 8, maxHeight: 260, overflow: "auto", paddingRight: 4, marginBottom: 10 }}>
        {messages.map((message, index) => (
          <article key={message.id ?? index} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, background: message.role === "operator" ? "rgba(240,253,244,0.75)" : "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4, color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800 }}>
              <span>{message.role ?? "message"}</span>
              <span>{formatDate(message.createdAt)}</span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{message.content}</div>
          </article>
        ))}
        {messages.length === 0 && <EmptyPanel label="No messages in this stage thread." />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={stageKey ? "Message this stage..." : "No active stage"}
          disabled={!stageKey || busy}
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13 }}
        />
        <button
          type="button"
          style={actionButtonStyle(!stageKey || busy || !draft.trim())}
          disabled={!stageKey || busy || !draft.trim()}
          onClick={() => {
            const content = draft.trim();
            if (!content) return;
            setDraft("");
            onSend(content);
          }}
          title={`Send message for ${sessionId}`}
        >
          <Send size={15} />
        </button>
      </div>
    </section>
  );
}

function EventsPanel({ events, milestone, finalPack }: { events: ReviewEvent[]; milestone?: MilestoneState; finalPack?: BlueprintSession["finalPack"] }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Milestone size={16} color="var(--color-primary)" />
        <h2 style={{ margin: 0, fontSize: 16 }}>Milestones & Events</h2>
      </div>
      {milestone?.enabled && (
        <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <strong style={{ fontSize: 13 }}>Active milestone</strong>
          <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>
            {milestone.plan?.find((item) => item.id === milestone.currentMilestoneId)?.title ?? milestone.currentMilestoneId ?? "None"}
          </div>
        </div>
      )}
      {finalPack && (
        <div style={{ border: "1px solid rgba(0,132,61,0.28)", background: "rgba(240,253,244,0.78)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <strong style={{ fontSize: 13 }}>Final pack · {finalPack.status}</strong>
          <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>{finalPack.summary}</div>
        </div>
      )}
      <div style={{ display: "grid", gap: 8, maxHeight: 290, overflow: "auto", paddingRight: 4 }}>
        {events.slice(0, 18).map((event, index) => (
          <article key={event.id ?? index} style={{ borderBottom: "1px solid var(--color-outline-variant)", paddingBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "var(--color-outline)", marginBottom: 3 }}>
              <span>{event.type ?? "event"} {event.stageKey ? `· ${event.stageKey}` : ""}</span>
              <span>{formatDate(event.createdAt)}</span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.45 }}>{event.message}</div>
          </article>
        ))}
        {events.length === 0 && <EmptyPanel label="No review events recorded yet." />}
      </div>
    </section>
  );
}

function LoopTracePanel({ trace, traceError, activeStageKey, compact = false }: { trace?: LoopTraceResponse | null; traceError?: unknown; activeStageKey?: string | null; compact?: boolean }) {
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bot size={16} color="var(--color-primary)" />
          <h2 style={{ margin: 0, fontSize: 16 }}>Loop Trace</h2>
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{activeStageKey ?? "no active stage"}</span>
        </div>
        {trace?.summary && (
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>
            {trace.summary.totalLlmCalls ?? 0} LLM · {trace.summary.totalToolInvocations ?? 0} tools
          </span>
        )}
      </div>
      {traceError ? <SmallError error={traceError} /> : null}
      {!trace && !traceError ? <EmptyPanel label="No loop trace is available for the active stage yet." /> : null}
      {trace && (
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "minmax(220px, 0.35fr) minmax(0, 1fr)", gap: 14 }}>
          {!compact && (
            <div style={{ display: "grid", gap: 8 }}>
              {(trace.phases ?? []).map((phase, index) => (
                <div key={`${phase.phase}-${index}`} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10 }}>
                  <strong style={{ fontSize: 12 }}>{phase.phase ?? "phase"}</strong>
                  <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>
                    {phase.llmCallCount ?? 0} calls · {phase.toolInvocationCount ?? 0} tools
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "grid", gap: 10, maxHeight: compact ? 280 : 560, overflow: "auto", paddingRight: 4 }}>
            {(trace.governanceEvents ?? []).slice(0, compact ? 3 : 8).map((event, index) => (
              <article key={`gov-${index}`} style={{ border: "1px solid rgba(180,83,9,0.24)", background: "rgba(255,251,235,0.72)", borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 12 }}>{event.kind ?? "governance event"} {event.phase ? `· ${event.phase}` : ""}</strong>
                <div style={{ color: "#78350f", fontSize: 12, marginTop: 4 }}>{valueText(event.details)}</div>
              </article>
            ))}
            {(trace.steps ?? []).slice(0, compact ? 4 : 28).map((step, index) => (
              <article key={step.llmCallId ?? index} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>Step {step.stepIndex ?? index + 1} {step.phase ? `· ${step.phase}` : ""}</strong>
                  <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{step.finishReason ?? "-"} · {formatDate(step.timestamp)}</span>
                </div>
                {step.responseText && <p style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.5 }}>{step.responseText.slice(0, 360)}</p>}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "var(--color-outline)", fontSize: 12 }}>
                  {(step.responseToolCalls ?? []).map((call, callIndex) => <span key={`${call.name}-${callIndex}`}>{call.name}</span>)}
                  {(step.toolInvocations ?? []).map((tool, toolIndex) => <span key={`${tool.name}-${toolIndex}`}>{tool.name} {tool.success === false ? "failed" : "ok"}</span>)}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ExportPanel({ session, artifacts }: { session: BlueprintSession; artifacts: BlueprintArtifact[] }) {
  const finalPack = session.finalPack;
  const exportableArtifacts = artifacts.filter((artifact) => artifact.kind === "final_implementation_pack" || artifact.consumableStatus || artifact.kind?.includes("pack"));
  return (
    <section className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Export Readiness</h2>
          <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>
            Final handoff state for the selected Workbench session.
          </p>
        </div>
        <StatusPill value={finalPack?.status ?? session.status} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
        <Fact label="Final pack" value={finalPack?.id ?? "not generated"} />
        <Fact label="Generated" value={formatDate(finalPack?.generatedAt)} />
        <Fact label="Artifact count" value={artifacts.length} />
        <Fact label="Export candidates" value={exportableArtifacts.length} />
      </div>
      {finalPack?.summary ? <p style={{ margin: 0, color: "var(--color-text)", fontSize: 13, lineHeight: 1.55 }}>{finalPack.summary}</p> : <EmptyPanel label="No final pack summary is available yet." />}
      {finalPack?.artifactKinds?.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {finalPack.artifactKinds.map((kind) => <StatusPill key={kind} value={kind} />)}
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, background: "#fff" }}>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800, letterSpacing: 0 }}>{label}</div>
      <div style={{ marginTop: 4, color: tone ?? "var(--color-text)", fontWeight: 850, fontSize: 15 }}>{valueText(value)}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800, letterSpacing: 0 }}>{label}</div>
      <div style={{ marginTop: 3, fontWeight: 750, fontSize: 13, overflowWrap: "anywhere" }}>{valueText(value)}</div>
    </div>
  );
}

function StatusPill({ value }: { value?: string }) {
  const tone = stageStatusTone[value ?? ""] ?? "#64748b";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${tone}33`, color: tone, background: `${tone}12`, borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
      {value ?? "unknown"}
    </span>
  );
}

function WorkbenchError({ error }: { error: unknown }) {
  const isUnauthorized = error instanceof WorkgraphError && error.status === 401;
  return (
    <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 850, color: "#991b1b", marginBottom: 5 }}>
        <CircleAlert size={16} />
        Could not load Workbench.
      </div>
      <div style={{ color: "#7f1d1d", fontSize: 13 }}>
        {isUnauthorized ? "Sign in from the platform shell, then refresh this surface." : error instanceof Error ? error.message : String(error)}
      </div>
    </section>
  );
}

function SmallError({ error }: { error: unknown }) {
  return (
    <div style={{ border: "1px solid rgba(185,28,28,0.24)", background: "rgba(254,242,242,0.72)", color: "#7f1d1d", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12 }}>
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 18, color: "var(--color-outline)", fontSize: 13, textAlign: "center" }}>
      {label}
    </div>
  );
}

function LoadingCard() {
  return (
    <section className="card" style={{ padding: 28, color: "var(--color-outline)", textAlign: "center" }}>
      Loading Workbench session...
    </section>
  );
}
