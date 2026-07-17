"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronRight, Play, Save, Sparkles, WandSparkles } from "lucide-react";
import { SynthesisShell } from "../SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "../ProjectPicker";
import { useLocalWorkspace } from "../hooks/useLocalWorkspace";

const STARTER_CODE = `FUNCTION evaluateInitiative(event)
  REQUIRE event.capabilityId
  REQUIRE event.description

  facts = extractFacts(event.documents)
  IF facts are incomplete
    RETURN requestHumanInput(facts.missing)
  END IF

  result = verifyAgainstSpecification(facts)
  IF result.passed
    EMIT "initiative.validated"
  ELSE
    EMIT "initiative.rework_requested"
  END IF
END FUNCTION`;

export function PseudoCodeStudioScreen() {
  const pathname = usePathname() ?? "/synthesis/pseudocode";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Pseudocode" fullBleed headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <PseudoCodeWorkspace projectId={projectId} /> : <NoProjectSelected surface="Pseudocode" />}</SynthesisShell>;
}

function PseudoCodeWorkspace({ projectId }: { projectId: string }) {
  const [code, setCode] = useLocalWorkspace<string>(`synthesis:pseudocode:${projectId}`, STARTER_CODE);
  const [validated, setValidated] = useState(false);
  const lines = code.split("\n");
  const blocks = useMemo(() => lines.map(line => line.trim()).filter(line => /^(FUNCTION|REQUIRE|IF|ELSE|RETURN|EMIT)/.test(line)).slice(0, 16), [lines]);
  const warnings = useMemo(() => {
    const result: string[] = [];
    if (!/REQUIRE/i.test(code)) result.push("No input preconditions are declared.");
    if (!/(ERROR|ELSE|RETURN)/i.test(code)) result.push("No failure or alternate path is visible.");
    if (!/EMIT/i.test(code)) result.push("No observable outcome event is emitted.");
    if (!/(APPROV|HUMAN)/i.test(code)) result.push("Consider an explicit human decision for low-confidence results.");
    return result;
  }, [code]);

  function insertReview() { setCode(current => `${current}\n\nIF result.confidence < 0.8\n  RETURN requestHumanApproval(result)\nEND IF`); }

  return (
    <div className="grid h-full min-h-[520px] overflow-hidden border border-outline-variant bg-surface-container-lowest lg:grid-cols-[minmax(360px,0.95fr)_minmax(300px,0.8fr)_300px]">
      <section className="flex min-h-0 flex-col border-r border-outline-variant bg-[#111827] text-slate-100">
        <div className="flex h-11 shrink-0 items-center border-b border-white/10 px-3"><span className="text-xs font-bold">initiative.logic</span><span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-slate-400"><Save size={12} /> Auto-saved</span></div>
        <div className="grid min-h-0 flex-1 grid-cols-[42px_1fr] overflow-hidden font-mono text-[13px] leading-6"><pre className="select-none overflow-hidden border-r border-white/10 py-4 pr-3 text-right text-slate-600">{lines.map((_, index) => index + 1).join("\n")}</pre><textarea value={code} onChange={event => { setCode(event.target.value); setValidated(false); }} spellCheck={false} className="h-full min-h-0 resize-none overflow-auto border-0 bg-transparent p-4 text-slate-200 outline-none" /></div>
      </section>
      <section className="min-h-0 overflow-auto bg-surface-container-low p-5 syn-dot-grid"><div className="mb-5 flex items-center justify-between"><div><div className="text-[10px] font-black uppercase tracking-[0.13em] text-on-surface-variant">Generated flow</div><h2 className="mt-1 text-sm font-black text-on-surface">Logic preview</h2></div><button type="button" className="btn-secondary h-8 text-xs" onClick={() => setValidated(true)}><Play size={13} /> Validate</button></div><div className="mx-auto flex max-w-sm flex-col items-center">{blocks.map((block, index) => <div key={`${block}-${index}`} className="contents"><div className={`w-full border px-4 py-3 text-center text-xs font-semibold shadow-sm ${block.startsWith("IF") ? "border-amber-300 bg-amber-50 text-amber-900" : block.startsWith("EMIT") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-outline-variant bg-surface-container-lowest text-on-surface"}`}>{block}</div>{index < blocks.length - 1 ? <ChevronRight size={16} className="my-1 rotate-90 text-outline" /> : null}</div>)}</div></section>
      <aside className="min-h-0 overflow-y-auto border-l border-outline-variant bg-surface-container-lowest p-5"><div className="flex items-center gap-2 text-sm font-black text-on-surface"><Sparkles size={16} className="text-secondary" /> Logic assistant</div><p className="mt-2 text-xs leading-5 text-on-surface-variant">Reviews intent structure before it becomes workflow or implementation code.</p>{validated ? <div className={`mt-5 flex items-start gap-2 border px-3 py-3 text-xs ${warnings.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-300 bg-emerald-50 text-emerald-900"}`}>{warnings.length ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}<span>{warnings.length ? `${warnings.length} design concern${warnings.length === 1 ? "" : "s"} found.` : "The logic has inputs, failure handling, and observable outcomes."}</span></div> : null}<div className="mt-5 space-y-3">{warnings.map(warning => <div key={warning} className="border-l-2 border-amber-400 pl-3 text-xs leading-5 text-on-surface-variant">{warning}</div>)}</div><button type="button" onClick={insertReview} className="btn-secondary mt-6 w-full justify-center text-xs"><WandSparkles size={14} /> Insert human review</button></aside>
    </div>
  );
}
