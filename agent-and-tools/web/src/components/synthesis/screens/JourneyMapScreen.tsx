"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Frown, Lightbulb, Map, Plus, Smile, Trash2 } from "lucide-react";
import { SynthesisShell } from "../SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "../ProjectPicker";
import { useProject } from "../hooks/useSynthesis";
import { useLocalWorkspace } from "../hooks/useLocalWorkspace";

type Lane = "actions" | "thoughts" | "pain" | "opportunities";
type JourneyNote = { id: string; text: string };
type JourneyStage = { id: string; title: string; lanes: Record<Lane, JourneyNote[]> };

const LANES: Array<{ id: Lane; label: string; icon: typeof Smile; color: string }> = [
  { id: "actions", label: "Customer actions", icon: Map, color: "#dbeafe" },
  { id: "thoughts", label: "Thinking and feeling", icon: Smile, color: "#dcfce7" },
  { id: "pain", label: "Pain points", icon: Frown, color: "#ffe4e6" },
  { id: "opportunities", label: "Opportunities", icon: Lightbulb, color: "#fef3c7" },
];

function starterStages(): JourneyStage[] {
  return ["Discover", "Evaluate", "Commit", "Adopt"].map((title, index) => ({
    id: `stage-${index + 1}`,
    title,
    lanes: { actions: [], thoughts: [], pain: [], opportunities: [] },
  }));
}

export function JourneyMapScreen() {
  const pathname = usePathname() ?? "/synthesis/journey";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Customer Journey Map" fullBleed headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <JourneyWorkspace projectId={projectId} /> : <NoProjectSelected surface="Journey Map" />}</SynthesisShell>;
}

function JourneyWorkspace({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);
  const [stages, setStages] = useLocalWorkspace<JourneyStage[]>(`synthesis:journey:${projectId}`, starterStages());
  const [stageId, setStageId] = useState("");
  const [lane, setLane] = useState<Lane>("actions");
  const [draft, setDraft] = useState("");
  const effectiveStageId = stageId || stages[0]?.id || "";

  const noteCount = useMemo(() => stages.reduce((sum, stage) => sum + LANES.reduce((laneSum, item) => laneSum + stage.lanes[item.id].length, 0), 0), [stages]);

  function addStage() {
    const number = stages.length + 1;
    setStages(current => [...current, { id: crypto.randomUUID(), title: `Stage ${number}`, lanes: { actions: [], thoughts: [], pain: [], opportunities: [] } }]);
  }

  function addNote() {
    if (!draft.trim() || !effectiveStageId) return;
    setStages(current => current.map(stage => stage.id === effectiveStageId ? { ...stage, lanes: { ...stage.lanes, [lane]: [...stage.lanes[lane], { id: crypto.randomUUID(), text: draft.trim() }] } } : stage));
    setDraft("");
  }

  function deleteNote(targetStage: string, targetLane: Lane, id: string) {
    setStages(current => current.map(stage => stage.id === targetStage ? { ...stage, lanes: { ...stage.lanes, [targetLane]: stage.lanes[targetLane].filter(note => note.id !== id) } } : stage));
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border border-outline-variant bg-surface-container-lowest">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant px-4 py-2">
        <div className="min-w-0 flex-1"><span className="text-xs font-black text-on-surface">{projectQ.data?.name ?? "Initiative journey"}</span><span className="ml-2 font-mono text-[10px] text-on-surface-variant">{stages.length} stages · {noteCount} observations</span></div>
        <button type="button" className="btn-secondary h-8 text-xs" onClick={addStage}><Plus size={14} /> Add stage</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto syn-dot-grid">
        <div className="grid min-w-[1040px]" style={{ gridTemplateColumns: `180px repeat(${stages.length}, minmax(220px, 1fr))` }}>
          <div className="sticky left-0 top-0 z-20 border-b border-r border-outline-variant bg-surface-container px-4 py-4 text-[10px] font-black uppercase tracking-[0.12em] text-on-surface-variant">Journey stage</div>
          {stages.map(stage => <div key={stage.id} className="sticky top-0 z-10 border-b border-r border-outline-variant bg-surface-container-lowest px-4 py-3"><input value={stage.title} onChange={event => setStages(current => current.map(item => item.id === stage.id ? { ...item, title: event.target.value } : item))} className="w-full border-0 bg-transparent text-sm font-black text-on-surface outline-none" /></div>)}
          {LANES.map(item => {
            const Icon = item.icon;
            return [<div key={`${item.id}-label`} className="sticky left-0 z-10 flex min-h-[142px] items-start gap-2 border-b border-r border-outline-variant bg-surface-container-lowest px-4 py-4 text-xs font-bold text-on-surface"><Icon size={15} className="mt-0.5 text-secondary" />{item.label}</div>, ...stages.map(stage => <div key={`${stage.id}-${item.id}`} className="min-h-[142px] border-b border-r border-outline-variant p-3"><div className="flex flex-wrap gap-2">{stage.lanes[item.id].map(note => <div key={note.id} className="group relative min-h-[78px] w-[calc(50%-4px)] min-w-[88px] border border-black/10 p-3 text-xs leading-5 text-slate-900 shadow-sm" style={{ background: item.color }}><span>{note.text}</span><button type="button" onClick={() => deleteNote(stage.id, item.id, note.id)} className="absolute right-1 top-1 hidden h-6 w-6 place-items-center rounded bg-white/80 text-slate-600 group-hover:grid" aria-label="Delete note"><Trash2 size={12} /></button></div>)}</div></div>)] as React.ReactNode[];
          })}
        </div>
      </div>
      <div className="grid shrink-0 gap-2 border-t border-outline-variant bg-surface-container-lowest p-3 md:grid-cols-[160px_180px_minmax(180px,1fr)_auto]">
        <select value={effectiveStageId} onChange={event => setStageId(event.target.value)} className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs">{stages.map(stage => <option key={stage.id} value={stage.id}>{stage.title}</option>)}</select>
        <select value={lane} onChange={event => setLane(event.target.value as Lane)} className="h-9 rounded-md border border-outline-variant bg-surface px-2 text-xs">{LANES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <input value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addNote(); }} placeholder="Add an observation to the journey" className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm outline-none focus:border-secondary" />
        <button type="button" className="btn-primary h-9 text-xs" onClick={addNote} disabled={!draft.trim()}><Plus size={14} /> Add note</button>
      </div>
    </div>
  );
}
