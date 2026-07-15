"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Archive, Check, CircleSlash2, Flag, Lock, Plus, Sparkles, ThumbsDown, ThumbsUp, Pin, RefreshCw, ShieldCheck, X } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { MetricTile, PageHero, PageShell, StatusPill } from "@/components/ui/primitives";

type Project = { id: string; name: string; code: string };
type Studio = { id: string; projectId: string; name: string; project: Project; _count?: { conceptArchives: number; proposals: number } };
type Axis = { key: string; label?: string; bins: string[] };
type ArchiveRow = { id: string; name: string; status: string; axes: Axis[]; axesRevision: number; frozenAt?: string | null };
type Card = { id: string; title: string; summary: string; body: Record<string, unknown>; authorType: string; status: string; declaredCoords: Record<string, string>; confirmedCoords?: Record<string, string> | null; cellKey?: string | null; compositeScore: number; pinned: boolean; votes?: Array<{ userId: string; direction: number }> };
type Cell = { id: string; cellKey: string; axesRevision: number; eliteCardId?: string | null; killed: boolean; killReason?: string | null; killClaimId?: string | null };
type Proposal = { id: string; scopeType: string; kind: string; status: string; payload: Record<string, unknown>; scopeRef: Record<string, unknown>; createdAt: string; authorType: string };
type ArchiveView = { archive: ArchiveRow; cards: Card[]; cells: Cell[]; proposals?: Proposal[]; coverage: { totalCells: number; occupiedCells: number; killedCells: number; emptyCells: number; coverage: number; emptyKeys: string[] }; staged: Card[] };

const fetcher = <T,>(path: string) => workgraphFetch<T>(path);
const defaultAxes: Axis[] = [
  { key: "novelty", label: "Novelty", bins: ["incremental", "distinctive", "frontier"] },
  { key: "feasibility", label: "Feasibility", bins: ["uncertain", "viable", "ready"] },
];

function normalizeKey(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "axis"; }
function cellKeyOf(axes: Axis[], coords: Record<string, string>) { return axes.map((axis) => `${axis.key}=${coords[axis.key]}`).join("|"); }
function cellsFor(axes: Axis[]) {
  const result: string[] = [];
  const walk = (index: number, parts: string[]) => {
    if (index === axes.length) { result.push(parts.join("|")); return; }
    const axis = axes[index];
    axis.bins.forEach((bin) => walk(index + 1, [...parts, `${axis.key}=${bin}`]));
  };
  walk(0, []);
  return result;
}

export function ConceptArchiveConsole() {
  const [projectId, setProjectId] = useState("");
  const [studioId, setStudioId] = useState("");
  const [archiveId, setArchiveId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectsQ = useSWR<{ items: Project[] }>("/studio/projects?status=ACTIVE", fetcher);
  const studiosQ = useSWR<{ items: Studio[] }>(projectId ? `/concept-archive/studios?projectId=${encodeURIComponent(projectId)}` : null, fetcher);
  const archivesQ = useSWR<{ items: ArchiveRow[] }>(studioId ? `/concept-archive/studios/${studioId}/archives` : null, fetcher);
  const archiveQ = useSWR<ArchiveView>(archiveId ? `/concept-archive/archives/${archiveId}` : null, fetcher, { refreshInterval: 10000 });
  const proposalsQ = useSWR<{ items: Proposal[] }>(studioId ? `/concept-archive/studios/${studioId}/proposals?status=PENDING` : null, fetcher, { refreshInterval: 15000 });
  const projects = projectsQ.data?.items ?? [];
  const studios = studiosQ.data?.items ?? [];
  const archives = archivesQ.data?.items ?? [];
  const view = archiveQ.data;

  useEffect(() => {
    const queryProject = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("projectId") ?? "";
    if (!projectId && projects.length) setProjectId(queryProject && projects.some((project) => project.id === queryProject) ? queryProject : projects[0].id);
  }, [projects, projectId]);
  useEffect(() => { if (studios.length && !studios.some((studio) => studio.id === studioId)) setStudioId(studios[0].id); }, [studios, studioId]);
  useEffect(() => { if (archives.length && !archives.some((archive) => archive.id === archiveId)) setArchiveId(archives[0].id); }, [archives, archiveId]);

  function fail(err: unknown) { setError(err instanceof Error ? err.message : "The archive operation failed."); setMessage(null); }
  async function ensureStudio() {
    if (!projectId) throw new Error("Choose a specification project first.");
    const studio = await workgraphFetch<Studio>("/concept-archive/studios", { method: "POST", body: JSON.stringify({ projectId }) });
    setStudioId(studio.id); await studiosQ.mutate(); return studio;
  }
  async function createArchive() {
    setError(null); setMessage(null);
    try {
      const studio = studioId ? { id: studioId } : await ensureStudio();
      const created = await workgraphFetch<ArchiveView>(`/concept-archive/studios/${studio.id}/archives`, { method: "POST", body: JSON.stringify({ name: `${projects.find((p) => p.id === projectId)?.name ?? "Concept"} Archive`, axes: defaultAxes, fitnessConfig: { evidence: 1, desirability: 1, feasibility: 1 } }) });
      setArchiveId(created.archive.id); await archivesQ.mutate(); setMessage("Archive created. Stage a concept, then confirm its cell coordinates.");
    } catch (err) { fail(err); }
  }

  return (
    <PageShell maxWidth={1440}>
      <PageHero eyebrow="Creative Studio" title="Concept Archive" description="Explore ideas as a sparse, evidence-aware map. Agents can propose; humans confirm coordinates, protect elites, and freeze the portfolio." icon={Archive} actions={<button className="btn-primary text-xs" type="button" onClick={createArchive}><Plus size={14} /> New archive</button>} />
      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
        <label className="text-xs font-semibold text-slate-600">Specification project<select className="input mt-1 w-full" value={projectId} onChange={(event) => { setProjectId(event.target.value); setStudioId(""); setArchiveId(""); }}><option value="">Choose project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.code}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Studio<select className="input mt-1 w-full" value={studioId} onChange={(event) => { setStudioId(event.target.value); setArchiveId(""); }}><option value="">Choose studio</option>{studios.map((studio) => <option key={studio.id} value={studio.id}>{studio.name}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Archive<select className="input mt-1 w-full" value={archiveId} onChange={(event) => setArchiveId(event.target.value)}><option value="">Choose archive</option>{archives.map((archive) => <option key={archive.id} value={archive.id}>{archive.name} · r{archive.axesRevision}</option>)}</select></label>
        <div className="flex items-end"><button className="btn-secondary text-xs" type="button" onClick={() => { projectsQ.mutate(); studiosQ.mutate(); archivesQ.mutate(); archiveQ.mutate(); }}><RefreshCw size={13} /> Refresh</button></div>
      </div>
      {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
      {message && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div>}
      {!view ? <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600"><Sparkles className="mx-auto mb-3 text-cyan-600" size={24} />Choose a project and archive to open the exploration map.</div> : <ArchiveSurface view={view} proposals={proposalsQ.data?.items ?? []} onChanged={() => { archiveQ.mutate(); proposalsQ.mutate(); }} onError={fail} />}
    </PageShell>
  );
}

function ArchiveSurface({ view, proposals, onChanged, onError }: { view: ArchiveView; proposals: Proposal[]; onChanged: () => void; onError: (error: unknown) => void }) {
  const axes = view.archive.axes;
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [coords, setCoords] = useState<Record<string, string>>(() => Object.fromEntries(axes.map((axis) => [axis.key, axis.bins[0]])));
  const [selectedCards, setSelectedCards] = useState<string[]>([]);
  const cellMap = useMemo(() => new Map(view.cells.filter((cell) => cell.axesRevision === view.archive.axesRevision).map((cell) => [cell.cellKey, cell])), [view.cells, view.archive.axesRevision]);
  const cardMap = useMemo(() => new Map(view.cards.map((card) => [card.id, card])), [view.cards]);
  const grid = cellsFor(axes);
  async function stage() {
    if (!title.trim() || !summary.trim()) return;
    try { await workgraphFetch(`/concept-archive/archives/${view.archive.id}/cards`, { method: "POST", body: JSON.stringify({ title: title.trim(), summary: summary.trim(), declaredCoords: coords, body: { evidence: [], assumptions: [], risks: [], links: [] }, fitness: { desirability: 0, feasibility: 0, evidence: 0 } }) }); setTitle(""); setSummary(""); onChanged(); } catch (error) { onError(error); }
  }
  async function confirm(card: Card) {
    try { await workgraphFetch(`/concept-archive/cards/${card.id}/confirm-coords`, { method: "POST", body: JSON.stringify({ coords: card.declaredCoords, replaceExisting: false }) }); onChanged(); } catch (error) { onError(error); }
  }
  async function vote(card: Card, direction: -1 | 1) { try { await workgraphFetch(`/concept-archive/cards/${card.id}/vote`, { method: "POST", body: JSON.stringify({ direction }) }); onChanged(); } catch (error) { onError(error); } }
  async function pin(card: Card) { try { await workgraphFetch(`/concept-archive/cards/${card.id}/${card.pinned ? "unpin" : "pin"}`, { method: "POST", body: JSON.stringify({}) }); onChanged(); } catch (error) { onError(error); } }
  async function kill(cellKey: string) { const reason = window.prompt("Why should this cell be killed? (20+ characters)"); if (!reason) return; try { await workgraphFetch(`/concept-archive/archives/${view.archive.id}/cells/kill`, { method: "POST", body: JSON.stringify({ cellKey, reason }) }); onChanged(); } catch (error) { onError(error); } }
  async function freeze() { if (selectedCards.length < 2) return; try { await workgraphFetch(`/concept-archive/archives/${view.archive.id}/freeze`, { method: "POST", body: JSON.stringify({ cardIds: selectedCards }) }); setSelectedCards([]); onChanged(); } catch (error) { onError(error); } }
  async function decide(proposal: Proposal, decision: "accept" | "reject") { try { await workgraphFetch(`/concept-archive/proposals/${proposal.id}/${decision}`, { method: "POST", body: JSON.stringify({}) }); onChanged(); } catch (error) { onError(error); } }

  return <div className="mt-6 space-y-5">
    <div className="grid gap-3 md:grid-cols-4"><MetricTile label="Coverage" value={`${Math.round(view.coverage.coverage * 100)}%`} tone="cyan" icon={Archive} /><MetricTile label="Occupied cells" value={view.coverage.occupiedCells} tone="emerald" icon={Check} /><MetricTile label="Killed cells" value={view.coverage.killedCells} tone="amber" icon={CircleSlash2} /><MetricTile label="Staged concepts" value={view.staged.length} tone="violet" icon={Sparkles} /></div>
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold text-slate-950">{view.archive.name}</h2><StatusPill state={view.archive.status === "FROZEN" ? "guarded" : "ready"} label={view.archive.status === "FROZEN" ? "Frozen" : `Active · r${view.archive.axesRevision}`} icon={view.archive.status === "FROZEN" ? Lock : ShieldCheck} /></div><p className="mt-1 text-sm text-slate-600">One elite per cell. Sparse is healthy; empty cells are questions, not failures.</p></div><button className="btn-secondary text-xs" type="button" disabled={selectedCards.length < 2 || view.archive.status === "FROZEN"} onClick={freeze}><Lock size={13} /> Freeze portfolio</button></div>
        <div className="mt-5 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(2, axes[1]?.bins.length ?? 2)}, minmax(120px, 1fr))` }}>{grid.map((key) => { const cell = cellMap.get(key); const card = cell?.eliteCardId ? cardMap.get(cell.eliteCardId) : undefined; return <div key={key} className={`min-h-[118px] rounded-lg border p-3 ${cell?.killed ? "border-amber-300 bg-amber-50" : card ? "border-emerald-200 bg-emerald-50/40" : "border-dashed border-slate-300 bg-slate-50/60"}`}><div className="flex items-start justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{key.replaceAll("|", " · ").replaceAll("=", ": ")}</span>{cell?.killed ? <CircleSlash2 size={14} className="text-amber-600" /> : card ? <Check size={14} className="text-emerald-600" /> : <button className="text-slate-400 hover:text-amber-600" title="Kill cell" type="button" onClick={() => kill(key)}><CircleSlash2 size={14} /></button>}</div>{card ? <div className="mt-3"><div className="font-semibold text-slate-900">{card.title}</div><div className="mt-1 line-clamp-2 text-xs text-slate-600">{card.summary}</div><div className="mt-2 flex items-center gap-1 text-[10px] text-slate-500"><span>{card.authorType.toLowerCase()}</span><span>·</span><span>{card.compositeScore.toFixed(2)}</span>{card.pinned && <Pin size={10} className="text-cyan-600" />}</div></div> : <div className="mt-5 text-xs text-slate-500">Open cell</div>}</div> })}</div>
      </section>
      <aside className="space-y-5"><section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><Flag size={16} className="text-cyan-600" /><h3 className="font-semibold text-slate-950">Stage a concept</h3></div><p className="mt-1 text-xs leading-5 text-slate-600">Coordinates are a declaration until a human confirms placement.</p><input className="input mt-4 w-full" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Concept title" /><textarea className="input mt-2 min-h-20 w-full" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What is the idea and why might it matter?" />{axes.map((axis) => <label key={axis.key} className="mt-2 block text-xs font-semibold text-slate-600">{axis.label ?? axis.key}<select className="input mt-1 w-full" value={coords[axis.key] ?? axis.bins[0]} onChange={(event) => setCoords((current) => ({ ...current, [axis.key]: event.target.value }))}>{axis.bins.map((bin) => <option key={bin} value={bin}>{bin}</option>)}</select></label>)}<button className="btn-primary mt-3 w-full text-xs" type="button" disabled={!title.trim() || !summary.trim() || view.archive.status === "FROZEN"} onClick={stage}><Plus size={13} /> Stage concept</button></section><ProposalInbox proposals={proposals} onDecision={decide} /></aside>
    </div>
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><div><h3 className="font-semibold text-slate-950">Staging tray</h3><p className="mt-1 text-xs text-slate-600">Review agent proposals and confirm their coordinates before they become elites.</p></div><span className="text-xs font-semibold text-slate-500">{view.staged.length} waiting</span></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{view.staged.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">Nothing staged. The next idea can enter here without disturbing the archive.</div> : view.staged.map((card) => <div key={card.id} className="rounded-lg border border-slate-200 p-4"><div className="flex items-start gap-2"><input type="checkbox" checked={selectedCards.includes(card.id)} onChange={(event) => setSelectedCards((ids) => event.target.checked ? [...ids, card.id] : ids.filter((id) => id !== card.id))} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-slate-900">{card.title}</span><span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">{card.authorType}</span></div><p className="mt-1 text-sm text-slate-600">{card.summary}</p><div className="mt-2 text-xs text-slate-500">Declared: {Object.entries(card.declaredCoords).map(([key, value]) => `${key}=${value}`).join(" · ")}</div></div></div><div className="mt-3 flex flex-wrap gap-2"><button className="btn-primary text-xs" type="button" onClick={() => confirm(card)}><Check size={13} /> Confirm coordinates</button><button className="btn-secondary text-xs" type="button" onClick={() => pin(card)}><Pin size={13} /> Pin</button><button className="btn-secondary text-xs" type="button" onClick={() => vote(card, 1)}><ThumbsUp size={13} /> Vote</button><button className="btn-secondary text-xs" type="button" onClick={() => vote(card, -1)}><ThumbsDown size={13} /> Challenge</button></div></div>)}</div></section>
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><Archive size={16} className="text-slate-500" /><h3 className="font-semibold text-slate-950">Archive history</h3><span className="ml-auto text-xs text-slate-500">Cards remain traceable after displacement</span></div><div className="mt-3 grid gap-2 md:grid-cols-3">{view.cards.filter((card) => card.status !== "STAGED").slice(0, 12).map((card) => <div key={card.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800">{card.title}</span><span className="text-[10px] font-bold uppercase text-slate-500">{card.status}</span></div><div className="mt-1 text-xs text-slate-500">{card.cellKey ?? "unplaced"} · score {card.compositeScore.toFixed(2)}</div></div>)}</div></section>
  </div>;
}

function ProposalInbox({ proposals, onDecision }: { proposals: Proposal[]; onDecision: (proposal: Proposal, decision: "accept" | "reject") => void }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-violet-600" /><h3 className="font-semibold text-slate-950">Proposal inbox</h3><span className="ml-auto rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700">{proposals.length} pending</span></div>{proposals.length === 0 ? <p className="mt-3 text-xs leading-5 text-slate-500">No proposals need a human decision.</p> : <div className="mt-3 space-y-3">{proposals.slice(0, 5).map((proposal) => <div key={proposal.id} className="rounded-lg border border-violet-100 bg-violet-50/50 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-violet-900">{proposal.kind} · {proposal.scopeType}</span><span className="text-[10px] uppercase text-slate-500">{proposal.authorType}</span></div><p className="mt-1 text-xs text-slate-600">{typeof proposal.payload?.reason === "string" ? proposal.payload.reason : "A proposed archive change is waiting for review."}</p><div className="mt-2 flex gap-2"><button className="btn-primary text-xs" type="button" onClick={() => onDecision(proposal, "accept")}><Check size={12} /> Accept</button><button className="btn-secondary text-xs" type="button" onClick={() => onDecision(proposal, "reject")}><X size={12} /> Reject</button></div></div>)}</div>}</section>;
}
