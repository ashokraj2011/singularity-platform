"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Bot, FilePlus2, MessageCircle, Paperclip, Plus, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { workgraphFetch } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { EmptyState, MonoMeta, StageHeader, SynButton, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";

type StudioPhase = "FRAME" | "EVIDENCE" | "DECIDE" | "SPECIFY" | "GENERATE" | "QUESTION" | "CHITCHAT";

interface StudioThread {
  id: string;
  kind: string;
  status: string;
  headSeq: number;
}

interface StudioWorkspace {
  id: string;
  title: string;
  status: string;
  specificationProjectId: string;
  threads?: StudioThread[];
}

interface StudioMessage {
  id: string;
  seq: number;
  role: string;
  authorType: string;
  agentRole?: string | null;
  content: Record<string, unknown>;
  proposalId?: string | null;
}

interface PaneData {
  phase: StudioPhase;
  nextAction: string;
  counts: { contextRefs: number; documents: number; proposals: number; pendingProposalItems: number };
  documents: Array<{ id: string; title: string; docType: string; status: string }>;
  proposals: Array<{ id: string; status: string; agentRole?: string | null; items: Array<{ id: string; status: string; title?: string | null }> }>;
}

interface ConverseResponse {
  decision: { route: string; phase: StudioPhase; agentRole: string; reason: string };
  message: unknown;
  proposalId: string | null;
}

const PHASES: StudioPhase[] = ["FRAME", "EVIDENCE", "DECIDE", "SPECIFY", "GENERATE"];

export function ConversationalStudioScreen() {
  const pathname = usePathname() ?? "/synthesis/studio";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Synthesis Studio" fullBleed headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? <Conductor projectId={projectId} /> : <NoProjectSelected surface="Synthesis Studio" />}
    </SynthesisShell>
  );
}

function Conductor({ projectId }: { projectId: string }) {
  const workspaces = useSyn<{ items: StudioWorkspace[] }>(`/synthesis/workspaces?projectId=${encodeURIComponent(projectId)}`);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = workspaces.data?.items ?? [];
  const activeWorkspaceId = workspaceId ?? items[0]?.id ?? null;
  const activeWorkspace = items.find((item) => item.id === activeWorkspaceId);
  const activeThreadId = threadId ?? activeWorkspace?.threads?.find((thread) => thread.kind === "WORKING_SESSION")?.id ?? null;
  const hasWorkspace = Boolean(activeWorkspaceId);

  useEffect(() => {
    if (workspaceId && !items.some((item) => item.id === workspaceId)) setWorkspaceId(null);
  }, [items, workspaceId]);

  async function createWorkspace() {
    setBusy("workspace"); setError(null);
    try {
      const created = await workgraphFetch<StudioWorkspace>("/synthesis/workspaces", {
        method: "POST",
        body: JSON.stringify({ specificationProjectId: projectId, title: "Synthesis Studio", purpose: "Guided initiative conversation" }),
      });
      setWorkspaceId(created.id);
      setThreadId(null);
      await workspaces.mutate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the studio."); }
    finally { setBusy(null); }
  }

  async function createThread() {
    if (!activeWorkspaceId) return;
    setBusy("thread"); setError(null);
    try {
      const thread = await workgraphFetch<StudioThread>(`/synthesis/workspaces/${activeWorkspaceId}/threads`, {
        method: "POST",
        body: JSON.stringify({ kind: "WORKING_SESSION", title: "Initiative conversation" }),
      });
      setThreadId(thread.id);
      await workspaces.mutate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start the conversation."); }
    finally { setBusy(null); }
  }

  if (workspaces.isLoading) return <div className="h-full p-5"><SynSkeleton rows={6} /></div>;
  if (workspaces.error) return <div className="h-full p-5"><SynError message={(workspaces.error as Error).message} /></div>;

  if (!hasWorkspace) {
    return (
      <div className="grid h-full min-h-[34rem] place-items-center p-6">
        <EmptyState
          icon={Sparkles}
          title="Start a guided initiative conversation"
          description="Frame the outcome in plain language. Synthesis will route questions, evidence, requirements, and generation through the governed studio services."
          action={<SynButton icon={Plus} onClick={createWorkspace} disabled={busy !== null}>Open Synthesis Studio</SynButton>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[34rem] min-w-0 flex-col gap-3">
      {error ? <SynError message={error} /> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.8fr)]">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant px-4 py-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-secondary-container text-on-secondary-container"><MessageCircle size={18} /></div>
            <div className="min-w-0"><MonoMeta>Guided conversation</MonoMeta><h1 className="truncate text-base font-black text-on-surface">{activeWorkspace?.title ?? "Synthesis Studio"}</h1></div>
            <div className="ml-auto flex items-center gap-2"><SynChip tone="success">Governed</SynChip><SynButton variant="ghost" icon={RefreshCw} onClick={() => void workspaces.mutate()} disabled={busy !== null}>Refresh</SynButton></div>
          </header>
          <div className="min-h-0 flex-1">{activeThreadId ? <Conversation workspaceId={activeWorkspaceId!} threadId={activeThreadId} paneProjectId={projectId} onError={setError} /> : (
            <div className="grid h-full place-items-center p-6"><EmptyState icon={Bot} title="Ready when you are" description="Start one conversation for this initiative. The studio chooses the governed agent path from your intent." action={<SynButton icon={Sparkles} onClick={createThread} disabled={busy !== null}>Start conversation</SynButton>} /></div>
          )}</div>
        </section>
        <StudioPane workspaceId={activeWorkspaceId!} projectId={projectId} phaseFallback="FRAME" />
      </div>
    </div>
  );
}

function Conversation({ workspaceId, threadId, paneProjectId, onError }: { workspaceId: string; threadId: string; paneProjectId: string; onError: (message: string | null) => void }) {
  const messages = useSyn<{ items: StudioMessage[] }>(`/synthesis/workspaces/${workspaceId}/threads/${threadId}/messages`, { refreshInterval: 3000 });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const value = text.trim();
    if (!value) return;
    setBusy(true); onError(null);
    try {
      await workgraphFetch<ConverseResponse>(`/synthesis/workspaces/${workspaceId}/threads/${threadId}/converse`, { method: "POST", body: JSON.stringify({ text: value }) });
      setText(""); await messages.mutate();
    } catch (cause) { onError(cause instanceof Error ? cause.message : "The studio could not complete that turn."); }
    finally { setBusy(false); }
  }

  const items = messages.data?.items ?? [];
  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.isLoading ? <SynSkeleton rows={4} /> : items.length === 0 ? (
          <div className="grid h-full place-items-center"><EmptyState icon={MessageCircle} title="Describe the outcome" description="Try: “We need a safer onboarding flow for enterprise customers.”" /></div>
        ) : items.map((message) => <MessageBubble key={message.id} message={message} />)}
      </div>
      <div className="shrink-0 border-t border-outline-variant bg-surface-container-low p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-on-surface-variant"><Sparkles size={14} className="text-secondary" /><span>Routing is automatic. Add evidence, ask a question, or shape the specification.</span></div>
        <div className="flex items-end gap-2">
          <Link href={`/synthesis/intake?project=${encodeURIComponent(paneProjectId)}`} className="icon-button mb-0.5" title="Add source document" aria-label="Add source document"><Paperclip size={16} /></Link>
          <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} rows={2} placeholder="What should we make clear, test, or decide?" className="min-h-10 flex-1 resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none focus:border-secondary" />
          <SynButton icon={ArrowUpRight} onClick={send} disabled={busy || !text.trim()} title="Send message">Send</SynButton>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: StudioMessage }) {
  const content = message.content ?? {};
  const kind = typeof content.kind === "string" ? content.kind : "TEXT";
  const text = typeof content.text === "string" ? content.text : typeof content.error === "string" ? content.error : "";
  const route = typeof content.route === "string" ? content.route : null;
  const phase = typeof content.phase === "string" ? content.phase : null;
  if (kind === "SYSTEM_STATE") {
    return <div className="mx-auto flex max-w-xl items-center justify-center gap-2 py-1 text-center text-[11px] text-on-surface-variant"><span className="h-1.5 w-1.5 rounded-full bg-secondary" />{route ? `Routed to ${route.toLowerCase()}` : "Studio state updated"}{phase ? <SynChip tone="neutral">{phase}</SynChip> : null}</div>;
  }
  const agent = message.authorType === "AGENT";
  return (
    <div className={`flex ${agent ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] rounded-xl border px-3.5 py-3 ${agent ? "border-secondary/30 bg-secondary-container/35" : "border-outline-variant bg-surface-container"}`}>
        <div className="mb-1.5 flex items-center gap-2"><MonoMeta>{agent ? message.agentRole ?? "Synthesis agent" : "You"}</MonoMeta>{message.proposalId ? <SynChip tone="tertiary">Review proposal</SynChip> : null}</div>
        <p className="whitespace-pre-wrap text-sm leading-6 text-on-surface">{text || "(No text returned)"}</p>
        {message.proposalId ? <Link href="/synthesis/desk" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-secondary">Open review <ArrowUpRight size={13} /></Link> : null}
      </div>
    </div>
  );
}

function StudioPane({ workspaceId, projectId, phaseFallback }: { workspaceId: string; projectId: string; phaseFallback: StudioPhase }) {
  const pane = useSyn<PaneData>(`/synthesis/workspaces/${workspaceId}/pane`, { refreshInterval: 3000 });
  const phase = pane.data?.phase ?? phaseFallback;
  const phaseIndex = Math.max(0, PHASES.indexOf(phase as (typeof PHASES)[number]));
  const counts = pane.data?.counts ?? { contextRefs: 0, documents: 0, proposals: 0, pendingProposalItems: 0 };
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
      <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
        <div className="flex items-center justify-between"><MonoMeta>Workspace pane</MonoMeta><SynChip tone="success">Live projection</SynChip></div>
        <h2 className="mt-2 text-lg font-black text-on-surface">What this conversation is building</h2>
        <div className="mt-4 grid grid-cols-5 gap-1">
          {PHASES.map((item, index) => <div key={item} className={`h-1.5 rounded-full ${index <= phaseIndex ? "bg-secondary" : "bg-surface-container-high"}`} title={item} />)}
        </div>
        <div className="mt-2 flex justify-between text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"><span>{phase}</span><span>{Math.min(100, Math.round(((phaseIndex + 1) / PHASES.length) * 100))}% shaped</span></div>
        <p className="mt-4 rounded-lg bg-surface-container px-3 py-2.5 text-sm leading-5 text-on-surface">{pane.data?.nextAction ?? "The pane will update as the conversation creates durable structure."}</p>
      </section>
      <section className="grid grid-cols-2 gap-2">
        <Metric label="Sources" value={counts.contextRefs} icon={Paperclip} />
        <Metric label="Documents" value={counts.documents} icon={FilePlus2} />
        <Metric label="Proposals" value={counts.proposals} icon={Sparkles} />
        <Metric label="Needs review" value={counts.pendingProposalItems} icon={Bot} />
      </section>
      <section className="rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
        <div className="flex items-center justify-between"><h3 className="text-sm font-black text-on-surface">Durable material</h3><Link href={`/synthesis/intake?project=${encodeURIComponent(projectId)}`} className="text-xs font-bold text-secondary">Add source</Link></div>
        {pane.isLoading ? <div className="mt-3"><SynSkeleton rows={3} /></div> : (pane.data?.documents ?? []).length === 0 ? <p className="mt-3 text-xs leading-5 text-on-surface-variant">Documents, proposals, and evidence will appear here as the conversation earns them.</p> : <div className="mt-3 space-y-2">{pane.data?.documents.slice(0, 5).map((document) => <Link key={document.id} href={`/synthesis/session?project=${encodeURIComponent(projectId)}`} className="block rounded-lg bg-surface-container px-3 py-2 hover:bg-surface-container-high"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-on-surface">{document.title}</span><SynChip tone="neutral">{document.status}</SynChip></div><MonoMeta>{document.docType}</MonoMeta></Link>)}</div>}
      </section>
      <Link href={`/synthesis/session?project=${encodeURIComponent(projectId)}`} className="inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 text-sm font-bold text-on-surface hover:border-secondary"><FilePlus2 size={15} /> Open full working session</Link>
    </aside>
  );
}

function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Paperclip }) {
  return <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-3"><Icon size={15} className="text-secondary" /><div className="mt-2 text-xl font-black tabular-nums text-on-surface">{value}</div><MonoMeta>{label}</MonoMeta></div>;
}

