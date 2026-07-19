"use client";

/**
 * Ask Synthesis sidecar (R1A 5.2) — the always-available door to the Facilitator agent from
 * any synthesis screen. It is mounted once inside SynthesisShell, scoped to the currently
 * selected initiative (?project=), and talks to the governed backend at POST/GET
 * /api/workgraph/synthesis/ask (the workgraph proxy rewrites this to /api/synthesis/ask).
 * The agent never mutates a record here — a material ask returns a PENDING proposal, surfaced
 * as a chip; humans review it in a Working Session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, X, Send, FileClock, BookMarked, PenLine } from "lucide-react";
import { useSelectedProjectId } from "../ProjectPicker";
import { workgraphFetch } from "@/lib/workgraph";
import { SynChip, EmptyState, SynError } from "../ui/kit";

type Disposition = { kind?: string; reason?: string };
interface AskMessage {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  text: string;
  citations?: unknown[];
  disposition?: Disposition;
  proposalId?: string | null;
}
interface AskHistory { items?: unknown[] }
interface AskResult { message?: unknown; disposition?: Disposition; proposalId?: string | null }

function messageText(content: Record<string, unknown>): string {
  if (typeof content.text === "string") return content.text;
  if (typeof content.error === "string") return content.error;
  return "";
}

function toAskMessage(raw: unknown): AskMessage {
  const m = (raw ?? {}) as Record<string, unknown>;
  const content = (m.content ?? {}) as Record<string, unknown>;
  const role = m.role === "USER" || m.role === "SYSTEM" ? m.role : "ASSISTANT";
  return {
    id: String(m.id ?? m.seq ?? `${role}-${(m.createdAt as string) ?? ""}`),
    role,
    text: messageText(content),
    citations: Array.isArray(content.citations) ? content.citations : undefined,
    disposition: (content.disposition as Disposition) ?? undefined,
    proposalId: (m.proposalId as string) ?? null,
  };
}

function citationLabel(c: unknown, i: number): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    for (const k of ["label", "title", "entityId", "id"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return `Source ${i + 1}`;
}

const dispositionTone = (kind?: string): "secondary" | "tertiary" | "error" | "neutral" =>
  kind === "PROPOSE" ? "tertiary" : kind === "BLOCKED" ? "error" : kind === "ANSWER" ? "secondary" : "neutral";

export function AskSynthesisSidecar() {
  const projectId = useSelectedProjectId();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the sidecar transcript when the panel opens for a selected initiative (read-only GET).
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoadingHistory(true);
    setError(null);
    workgraphFetch<AskHistory>(`/synthesis/ask?specificationProjectId=${encodeURIComponent(projectId)}`)
      .then((res) => { if (!cancelled) setMessages((res?.items ?? []).map(toAskMessage)); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load history"); })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  // Reset the transcript when the initiative changes so answers never cross projects.
  useEffect(() => { setMessages([]); setError(null); }, [projectId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (!question || !projectId || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { id: `local-user-${m.length}`, role: "USER", text: question }]);
    try {
      const res = await workgraphFetch<AskResult>("/synthesis/ask", {
        method: "POST",
        body: JSON.stringify({ specificationProjectId: projectId, question }),
      });
      const assistant = toAskMessage(res?.message);
      assistant.disposition = res?.disposition ?? assistant.disposition;
      assistant.proposalId = res?.proposalId ?? assistant.proposalId ?? null;
      setMessages((m) => [...m, assistant]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Ask failed";
      setError(msg);
      setMessages((m) => [...m, { id: `local-sys-${m.length}`, role: "SYSTEM", text: msg }]);
    } finally {
      setBusy(false);
    }
  }, [input, projectId, busy]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Ask Synthesis"
        aria-label="Ask Synthesis"
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-outline-variant bg-secondary-container px-3 text-xs font-bold text-on-secondary-container transition-colors hover:bg-secondary hover:text-on-secondary"
      >
        <Sparkles size={14} />
        <span className="hidden sm:inline">Ask</span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Ask Synthesis">
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col border-l border-outline-variant bg-surface-container-lowest shadow-2xl">
            <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-outline-variant px-4">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-secondary text-on-secondary"><Sparkles size={15} /></span>
              <div className="min-w-0">
                <div className="truncate text-sm font-black text-on-surface">Ask Synthesis</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">Facilitator · governed</div>
              </div>
              <div className="ml-auto flex items-center gap-1">
                {projectId ? (
                  <Link
                    href={`/synthesis/session?project=${encodeURIComponent(projectId)}`}
                    onClick={() => setOpen(false)}
                    title="Open a full Working Session for this initiative"
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-outline-variant px-2.5 text-[11px] font-bold text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
                  >
                    <PenLine size={13} /><span className="hidden sm:inline">Working Session</span>
                  </Link>
                ) : null}
                <button type="button" onClick={() => setOpen(false)} className="icon-button" title="Close" aria-label="Close">
                  <X size={16} />
                </button>
              </div>
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {!projectId ? (
                <EmptyState icon={Sparkles} title="Select an initiative" description="Pick an initiative from the picker, then ask the Facilitator a question about it." />
              ) : loadingHistory ? (
                <div className="space-y-3">
                  <div className="h-16 animate-pulse rounded-lg bg-surface-container-high/70" />
                  <div className="h-12 animate-pulse rounded-lg bg-surface-container-high/70" />
                </div>
              ) : messages.length === 0 ? (
                <EmptyState icon={BookMarked} title="Ask about this initiative" description="Ask for a summary, a contradiction check, or to draft a PRD. Answers cite their sources; changes come back as reviewable proposals." />
              ) : (
                <div className="space-y-4">
                  {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
                  {busy ? <div className="text-xs font-semibold text-on-surface-variant">Facilitator is thinking…</div> : null}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-outline-variant p-3">
              {error ? <div className="mb-2"><SynError message={error} /></div> : null}
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
                  placeholder={projectId ? "Ask the Facilitator…" : "Select an initiative first"}
                  disabled={!projectId || busy}
                  rows={2}
                  className="min-h-[40px] flex-1 resize-none rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-secondary focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!projectId || busy || !input.trim()}
                  className="btn-primary grid h-10 w-10 shrink-0 place-items-center disabled:opacity-45"
                  title="Send"
                  aria-label="Send"
                >
                  <Send size={16} />
                </button>
              </div>
              <div className="mt-1.5 text-[10px] text-on-surface-variant">Enter to send · Shift+Enter for a new line. The agent proposes; you decide.</div>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function MessageBubble({ message }: { message: AskMessage }) {
  const isUser = message.role === "USER";
  const isSystem = message.role === "SYSTEM";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[92%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-secondary text-on-secondary"
            : isSystem
              ? "border border-error/30 bg-error-container/40 text-on-error-container"
              : "bg-surface-container-high text-on-surface",
        ].join(" ")}
      >
        <div className="whitespace-pre-wrap break-words">{message.text || (isSystem ? "(no message)" : "")}</div>

        {message.citations && message.citations.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.citations.map((c, i) => (
              <SynChip key={i} tone="neutral" icon={BookMarked}>{citationLabel(c, i)}</SynChip>
            ))}
          </div>
        ) : null}

        {!isUser && (message.proposalId || (message.disposition?.kind && message.disposition.kind !== "ANSWER")) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {message.disposition?.kind ? (
              <SynChip tone={dispositionTone(message.disposition.kind)}>{message.disposition.kind}</SynChip>
            ) : null}
            {message.proposalId ? (
              <SynChip tone="tertiary" icon={FileClock}>Proposal drafted — review in a Working Session</SynChip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
