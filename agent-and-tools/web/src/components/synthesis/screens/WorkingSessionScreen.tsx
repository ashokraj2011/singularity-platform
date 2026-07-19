"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { PenLine, Plus, Send, FileText, Library, Bot, Sparkles, Eye } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { EmptyState, StageHeader, SynButton, SynChip, SynError, SynSkeleton, MonoMeta } from "@/components/synthesis/ui/kit";
import { DocumentEditor } from "@/components/synthesis/working-session/DocumentEditor";
import { ProposalReview } from "@/components/synthesis/working-session/ProposalReview";

/**
 * Synthesis — Working Session. The agentic co-authoring surface: tag sources (Context
 * Library), draft documents (Working Artifact), and converse with the Facilitator /
 * Evidence Curator / Requirements Editor (Agent Conversation). Every agent turn runs
 * behind a context manifest and lands material change as a reviewable proposal — this UI
 * is the front door to the R1A backend (/api/synthesis/*).
 */

interface Thread { id: string; kind: string; status: string; headSeq: number }
interface Workspace { id: string; title: string; status: string; lastActivityAt: string; threads?: Thread[] }
interface WMessage { id: string; seq: number; role: string; authorType: string; agentRole?: string | null; content: Record<string, unknown>; proposalId?: string | null }
interface ContextRef { id: string; entityType: string; entityId: string; label?: string | null; referenceMode: string }
interface Doc { id: string; docType: string; title: string; status: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const AGENTS = [
  { role: "FACILITATOR", label: "Facilitator" },
  { role: "EVIDENCE_CURATOR", label: "Evidence Curator" },
  { role: "REQUIREMENTS_EDITOR", label: "Requirements Editor" },
] as const;
const REF_KINDS = ["SOURCE", "CLAIM", "DECISION", "REQUIREMENT", "SPECIFICATION", "WORKITEM", "PERSON"] as const;

export function WorkingSessionScreen() {
  const pathname = usePathname() ?? "/synthesis/session";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Working Session" headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? <Session projectId={projectId} /> : <NoProjectSelected surface="Working Session" />}
    </SynthesisShell>
  );
}

function Session({ projectId }: { projectId: string }) {
  const workspaces = useSyn<{ items: Workspace[] }>(`/synthesis/workspaces?projectId=${encodeURIComponent(projectId)}`);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = workspaces.data?.items ?? [];
  const active = activeId ?? items[0]?.id ?? null;

  async function createSession() {
    setBusy(true); setError(null);
    try {
      const ws = await workgraphFetch<Workspace>(`/synthesis/workspaces`, { method: "POST", body: JSON.stringify({ specificationProjectId: projectId, title: "Working session" }) });
      await workspaces.mutate();
      setActiveId(ws.id);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  if (workspaces.isLoading) return <SynSkeleton rows={6} />;
  if (workspaces.error) return <SynError message={msg(workspaces.error)} />;

  return (
    <div>
      <StageHeader
        eyebrow="Co-author with agents" title="Working Session" icon={PenLine}
        description="Tag your sources, draft with the Facilitator, Evidence Curator, and Requirements Editor, and review every change as a proposal."
        actions={<SynButton icon={Plus} onClick={createSession} disabled={busy}>New session</SynButton>}
      />
      {error ? <SynError message={error} /> : null}
      {items.length === 0 ? (
        <EmptyState icon={PenLine} title="No working sessions yet" description="Start a session to co-author documents with agents behind a context manifest." action={<SynButton icon={Plus} onClick={createSession} disabled={busy}>Start a session</SynButton>} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-5">
            {items.map((w) => (
              <button key={w.id} onClick={() => setActiveId(w.id)}
                className={["h-8 px-3 rounded-lg text-sm font-semibold", w.id === active ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container text-on-surface-variant hover:text-on-surface"].join(" ")}>
                {w.title}
              </button>
            ))}
          </div>
          {active ? <ThreePane key={active} workspaceId={active} /> : null}
        </>
      )}
    </div>
  );
}

function ThreePane({ workspaceId }: { workspaceId: string }) {
  const workspace = useSyn<Workspace>(`/synthesis/workspaces/${workspaceId}`);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = threadId ?? workspace.data?.threads?.find((t) => t.kind === "WORKING_SESSION")?.id ?? null;

  async function startThread() {
    setBusy(true);
    try {
      const t = await workgraphFetch<Thread>(`/synthesis/workspaces/${workspaceId}/threads`, { method: "POST", body: JSON.stringify({ kind: "WORKING_SESSION", title: "Session thread" }) });
      await workspace.mutate();
      setThreadId(t.id);
    } finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.1fr)] gap-4">
      <Pane title="Context Library" icon={Library}><ContextLibrary workspaceId={workspaceId} /></Pane>
      <Pane title="Working Artifact" icon={FileText}><WorkingArtifact workspaceId={workspaceId} /></Pane>
      <Pane title="Agent Conversation" icon={Bot}>
        {active ? <AgentConversation workspaceId={workspaceId} threadId={active} /> : (
          <EmptyState icon={Bot} title="No conversation yet" description="Start a thread to talk with the agents." action={<SynButton icon={Sparkles} onClick={startThread} disabled={busy}>Start conversation</SynButton>} />
        )}
      </Pane>
    </div>
  );
}

function Pane({ title, icon: Icon, children }: { title: string; icon: typeof Library; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-outline-variant bg-surface-container-low overflow-hidden flex flex-col min-h-[26rem]">
      <header className="flex items-center gap-2 px-4 h-11 border-b border-outline-variant text-on-surface">
        <Icon size={15} strokeWidth={2} /><span className="text-sm font-semibold">{title}</span>
      </header>
      <div className="p-3 overflow-y-auto flex-1">{children}</div>
    </section>
  );
}

function ContextLibrary({ workspaceId }: { workspaceId: string }) {
  const refs = useSyn<{ items: ContextRef[] }>(`/synthesis/workspaces/${workspaceId}/context-refs`);
  const [entityType, setEntityType] = useState<string>("CLAIM");
  const [entityId, setEntityId] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!entityId.trim()) return;
    setBusy(true);
    try {
      await workgraphFetch(`/synthesis/workspaces/${workspaceId}/context-refs`, { method: "POST", body: JSON.stringify({ entityType, entityId: entityId.trim() }) });
      setEntityId(""); await refs.mutate();
    } finally { setBusy(false); }
  }

  const items = refs.data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="h-8 rounded-lg bg-surface-container text-on-surface text-xs px-2 border border-outline-variant">
          {REF_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="entity id" className="h-8 flex-1 min-w-0 rounded-lg bg-surface-container text-on-surface text-xs px-2 border border-outline-variant" />
        <SynButton variant="secondary" icon={Plus} onClick={add} disabled={busy} />
      </div>
      {refs.isLoading ? <SynSkeleton rows={3} /> : items.length === 0 ? (
        <p className="text-xs text-on-surface-variant px-1 py-4">Tag claims, decisions, specs, or sources to ground the agents.</p>
      ) : items.map((r) => (
        <div key={r.id} className="rounded-lg bg-surface-container px-3 py-2">
          <div className="flex items-center gap-2"><SynChip tone="secondary">{r.entityType}</SynChip><MonoMeta>{r.referenceMode === "PINNED" ? "pinned" : "live"}</MonoMeta></div>
          <p className="mt-1 text-xs text-on-surface truncate" title={r.label ?? r.entityId}>{r.label ?? r.entityId}</p>
        </div>
      ))}
    </div>
  );
}

function WorkingArtifact({ workspaceId }: { workspaceId: string }) {
  const docs = useSyn<{ items: Doc[] }>(`/synthesis/documents?workspaceId=${encodeURIComponent(workspaceId)}`);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  async function newDoc() {
    setBusy(true);
    try {
      // A workspace document needs its project — resolve it from the workspace.
      const ws = await workgraphFetch<Workspace & { specificationProjectId?: string }>(`/synthesis/workspaces/${workspaceId}`);
      const projectId = (ws as { specificationProjectId?: string }).specificationProjectId;
      if (!projectId) return;
      const d = await workgraphFetch<Doc>(`/synthesis/documents`, { method: "POST", body: JSON.stringify({ specificationProjectId: projectId, workspaceId, docType: "NARRATIVE", title: "Untitled document" }) });
      await docs.mutate();
      setSelected(d.id);
    } finally { setBusy(false); }
  }

  if (selected) return <DocumentEditor documentId={selected} onBack={() => { setSelected(null); void docs.mutate(); }} />;

  const items = docs.data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><SynButton variant="secondary" icon={Plus} onClick={newDoc} disabled={busy}>New document</SynButton></div>
      {docs.isLoading ? <SynSkeleton rows={4} /> : items.length === 0 ? (
        <EmptyState icon={FileText} title="No documents" description="Draft a PRD, brief, or readout — or ask an agent to." />
      ) : items.map((d) => (
        <button key={d.id} type="button" onClick={() => setSelected(d.id)} className="block w-full rounded-lg bg-surface-container px-3 py-2.5 text-left hover:bg-surface-container-high">
          <div className="flex items-center gap-2"><SynChip tone="tertiary">{d.docType}</SynChip><SynChip tone="neutral">{d.status.toLowerCase()}</SynChip></div>
          <p className="mt-1.5 text-sm font-semibold text-on-surface">{d.title}</p>
        </button>
      ))}
    </div>
  );
}

interface ManifestSummary { tokenEstimate: number; pinnedCount: number; followingCount: number; unresolvedCount: number }
interface ManifestResp { manifest: { id: string; tokenEstimate?: number; pinnedCount?: number; followingCount?: number; summary?: ManifestSummary } }

function AgentConversation({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const messages = useSyn<{ items: WMessage[] }>(`/synthesis/workspaces/${workspaceId}/threads/${threadId}/messages`);
  const [role, setRole] = useState<string>("FACILITATOR");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestResp["manifest"] | null>(null);

  async function preview() {
    setError(null);
    try {
      const r = await workgraphFetch<ManifestResp>(`/synthesis/workspaces/${workspaceId}/threads/${threadId}/manifest`, { method: "POST" });
      setManifest(r.manifest);
    } catch (e) { setError(msg(e)); }
  }

  async function send() {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await workgraphFetch(`/synthesis/workspaces/${workspaceId}/threads/${threadId}/agent-turn`, { method: "POST", body: JSON.stringify({ role, message: text.trim() }) });
      setText(""); setManifest(null); await messages.mutate();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  const items = messages.data?.items ?? [];
  const tok = manifest ? (manifest.tokenEstimate ?? manifest.summary?.tokenEstimate ?? 0) : 0;
  const pinned = manifest ? (manifest.pinnedCount ?? manifest.summary?.pinnedCount ?? 0) : 0;
  const following = manifest ? (manifest.followingCount ?? manifest.summary?.followingCount ?? 0) : 0;
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-2.5 overflow-y-auto">
        {messages.isLoading ? <SynSkeleton rows={3} /> : items.length === 0 ? (
          <p className="text-xs text-on-surface-variant px-1 py-4">Ask an agent to draft, curate evidence, or refine requirements. Every material change lands as a reviewable proposal.</p>
        ) : items.map((m) => (
          <div key={m.id}>
            <div className={["rounded-lg px-3 py-2", m.authorType === "AGENT" ? "bg-secondary-container/60" : m.authorType === "SYSTEM" ? "bg-error-container/40" : "bg-surface-container"].join(" ")}>
              <div className="flex items-center gap-2 mb-1"><MonoMeta>{m.agentRole ?? m.authorType}</MonoMeta>{m.proposalId ? <SynChip tone="tertiary">proposal</SynChip> : null}</div>
              <p className="text-xs text-on-surface whitespace-pre-wrap">{String((m.content as { text?: string; error?: string }).text ?? (m.content as { error?: string }).error ?? "")}</p>
            </div>
            {m.proposalId ? <ProposalReview proposalId={m.proposalId} /> : null}
          </div>
        ))}
      </div>
      {error ? <div className="mt-2"><SynError message={error} /></div> : null}
      {manifest ? (
        <div className="mt-2 flex items-center gap-3 rounded-lg bg-surface-container px-3 py-2 text-[11px] text-on-surface-variant">
          <MonoMeta>manifest</MonoMeta><span>~{tok} tok</span><span>{pinned} pinned</span><span>{following} following</span>
        </div>
      ) : null}
      <div className="mt-3 border-t border-outline-variant pt-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <select value={role} onChange={(e) => setRole(e.target.value)} className="h-8 flex-1 rounded-lg bg-surface-container text-on-surface text-xs px-2 border border-outline-variant">
            {AGENTS.map((a) => <option key={a.role} value={a.role}>{a.label}</option>)}
          </select>
          <SynButton variant="ghost" icon={Eye} onClick={preview} disabled={busy} title="Preview the context manifest">Context</SynButton>
        </div>
        <div className="flex gap-1.5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Ask the agent…" className="flex-1 min-w-0 rounded-lg bg-surface-container text-on-surface text-xs p-2 border border-outline-variant resize-none" />
          <SynButton icon={Send} onClick={send} disabled={busy || !text.trim()} />
        </div>
      </div>
    </div>
  );
}
