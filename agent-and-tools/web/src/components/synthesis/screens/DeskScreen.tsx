"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertOctagon, Check, ChevronRight, Clock3, Inbox, ListChecks, RefreshCw, Sparkles, X } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "@/components/synthesis/ProjectPicker";
import { useDesk, useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { EmptyState, MonoMeta, StageHeader, SynButton, SynChip, SynError, SynSkeleton } from "@/components/synthesis/ui/kit";
import type { SynAttentionBand, SynAttentionItem, SynBusinessReadout } from "@/components/synthesis/types";

const BANDS: Array<{ key: SynAttentionBand; label: string; hint: string; icon: typeof AlertOctagon; tone: "error" | "tertiary" | "secondary" | "neutral" }> = [
  { key: "BLOCKING", label: "Blocking", hint: "A delivery or governance transition cannot continue.", icon: AlertOctagon, tone: "error" },
  { key: "DECIDE", label: "Decide", hint: "A human choice is required; agents cannot commit it.", icon: ListChecks, tone: "tertiary" },
  { key: "REVIEW", label: "Review", hint: "Material evidence or risk warrants attention.", icon: Inbox, tone: "secondary" },
  { key: "DIGEST", label: "Digest", hint: "Low-stakes signals remain visible without interrupting work.", icon: Clock3, tone: "neutral" },
];

export function DeskScreen() {
  const pathname = usePathname() ?? "/synthesis/desk";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="The Desk" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <Desk projectId={projectId} /> : <NoProjectSelected surface="The Desk" />}</SynthesisShell>;
}

function Desk({ projectId }: { projectId: string }) {
  const desk = useDesk(projectId, 12, { refreshInterval: 30_000 });
  const brief = useSyn<SynBusinessReadout | null>(`/studio/experience/projects/${projectId}/morning-brief`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError(null);
    try { await operation(); await Promise.all([desk.mutate(), brief.mutate()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be completed."); }
    finally { setBusy(null); }
  }

  if (desk.isLoading) return <SynSkeleton rows={8} />;
  if (desk.error || !desk.data) return <SynError message={desk.error instanceof Error ? desk.error.message : "The Desk is unavailable."} />;
  const data = desk.data;
  return <div className="space-y-7">
    <StageHeader eyebrow="Human attention" title="Exceptions, ranked" description="Passing gates stay quiet. Work appears here only when a human decision, material review, or time-bound response is needed." icon={Inbox} actions={<><SynButton variant="secondary" icon={RefreshCw} disabled={Boolean(busy)} onClick={() => void act("refresh", () => workgraphFetch("/studio/experience/desk/refresh", { method: "POST", body: JSON.stringify({ projectId }) }))}>Refresh</SynButton><SynButton icon={Sparkles} disabled={Boolean(busy)} onClick={() => void act("shift", () => workgraphFetch(`/studio/experience/projects/${projectId}/overnight/run`, { method: "POST" }))}>{busy === "shift" ? "Running…" : "Run shift"}</SynButton></>} />
    {error ? <SynError message={error} /> : null}
    <div className="grid overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest sm:grid-cols-4">
      <Metric label="Open" value={data.totalOpen} />
      <Metric label="Today’s budget" value={data.reviewBudget} />
      <Metric label="In view" value={data.visibleCount} />
      <Metric label="Batched digest" value={data.digestCount} />
    </div>
    {brief.data ? <section className="border-l-4 border-secondary bg-secondary-container/40 px-5 py-4"><div className="flex flex-wrap items-center gap-3"><Sparkles size={17} className="text-secondary" /><strong className="text-sm text-on-surface">Morning brief</strong><MonoMeta>sha256:{brief.data.contentHash.slice(0, 12)}</MonoMeta><MonoMeta>{new Date(brief.data.createdAt).toLocaleString()}</MonoMeta></div><pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap font-sans text-sm leading-6 text-on-surface-variant">{brief.data.renderedMarkdown}</pre></section> : null}
    {data.totalOpen === 0 ? <EmptyState icon={Check} title="No exceptions need attention" description="Passing gates remain silent. New decisions, challenges, risks, or overdue reviews will appear here." /> : <div className="space-y-8">{BANDS.map(({ key: band, ...definition }) => <Band key={band} band={band} {...definition} items={data.grouped[band] ?? []} busy={busy} onResolve={(item, resolution) => act(`${item.id}:${resolution}`, () => workgraphFetch(`/studio/experience/attention/${item.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution, note: resolution === "DEFERRED" ? "Deferred from the Desk for later review." : undefined }) }))} />)}</div>}
    <div className="flex items-center justify-between border-t border-outline-variant pt-4 text-xs text-on-surface-variant"><span>Ranking = stakes × uncertainty × urgency</span><span>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span></div>
  </div>;
}

function Band({ band, label, hint, icon: Icon, tone, items, busy, onResolve }: { band: SynAttentionBand; label: string; hint: string; icon: typeof AlertOctagon; tone: "error" | "tertiary" | "secondary" | "neutral"; items: SynAttentionItem[]; busy: string | null; onResolve: (item: SynAttentionItem, resolution: string) => Promise<void> }) {
  if (!items.length) return null;
  return <section><div className="mb-2 flex items-center gap-2"><Icon size={17} className={band === "BLOCKING" ? "text-error" : band === "DECIDE" ? "text-tertiary" : "text-secondary"} /><h2 className="font-black text-on-surface">{label}</h2><SynChip tone={tone}>{items.length}</SynChip><span className="text-xs text-on-surface-variant">{hint}</span></div><div className="divide-y divide-outline-variant border-y border-outline-variant">{items.map(item => <AttentionRow key={item.id} item={item} busy={busy} onResolve={onResolve} />)}</div></section>;
}

function AttentionRow({ item, busy, onResolve }: { item: SynAttentionItem; busy: string | null; onResolve: (item: SynAttentionItem, resolution: string) => Promise<void> }) {
  const sourceActionRequired = item.band === "BLOCKING" || item.band === "DECIDE";
  return <article className="grid gap-4 bg-surface-container-lowest px-4 py-4 lg:grid-cols-[minmax(0,1fr)_220px_auto] lg:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-on-surface">{item.title}</strong><SynChip mono>{item.sourceType.replaceAll("_", " ")}</SynChip>{item.assignedToId ? <MonoMeta>owner {item.assignedToId}</MonoMeta> : null}</div><p className="mt-1 text-sm leading-5 text-on-surface-variant">{item.summary}</p><p className="mt-2 text-[11px] text-on-surface-variant">{item.rankingReason}</p></div><div><div className="mb-1 flex justify-between text-[10px] font-bold uppercase text-on-surface-variant"><span>Priority</span><span>{item.priority.toFixed(2)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high"><div className={item.band === "BLOCKING" ? "h-full bg-error" : item.band === "DECIDE" ? "h-full bg-tertiary" : "h-full bg-secondary"} style={{ width: `${Math.min(100, (item.priority / 125) * 100)}%` }} /></div><div className="mt-2 flex gap-3 text-[10px] text-on-surface-variant"><span>S {item.stakes.toFixed(1)}</span><span>U {item.uncertainty.toFixed(1)}</span><span>T {item.urgency.toFixed(1)}</span></div></div><div className="flex items-center justify-end gap-1">{sourceActionRequired ? <span className="mr-1 text-[10px] font-bold uppercase text-on-surface-variant">Act at source</span> : null}{item.actionHref ? <Link href={item.actionHref} className="icon-button" title="Open source" aria-label="Open source"><ChevronRight size={16} /></Link> : null}{!sourceActionRequired ? <><button className="icon-button text-secondary" title="Confirm" aria-label="Confirm" disabled={Boolean(busy)} onClick={() => void onResolve(item, "CONFIRMED")}><Check size={16} /></button><button className="icon-button text-error" title="Dismiss" aria-label="Dismiss" disabled={Boolean(busy)} onClick={() => void onResolve(item, "DISMISSED")}><X size={16} /></button></> : null}</div></article>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="border-b border-outline-variant px-4 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><MonoMeta>{label}</MonoMeta><div className="mt-1 text-2xl font-black tabular-nums text-on-surface">{value}</div></div>; }
