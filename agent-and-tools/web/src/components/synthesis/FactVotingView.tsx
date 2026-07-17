"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Sparkles, ThumbsDown, ThumbsUp, Vote } from "lucide-react";
import { useClaims, useProject } from "./hooks/useSynthesis";
import { useLocalWorkspace } from "./hooks/useLocalWorkspace";
import { EmptyState, MonoMeta, SynError, SynSkeleton } from "./ui/kit";

type FactVote = { up: number; down: number; choice: "up" | "down" | null };

export function FactVotingView({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);
  const claimsQ = useClaims(projectId, {}, { refreshInterval: 15000 });
  const [votes, setVotes] = useLocalWorkspace<Record<string, FactVote>>(`synthesis:fact-votes:${projectId}`, {});
  const claims = claimsQ.data?.items ?? [];

  const ranked = useMemo(() => [...claims].sort((left, right) => {
    const lv = votes[left.id] ?? { up: 0, down: 0 };
    const rv = votes[right.id] ?? { up: 0, down: 0 };
    return (rv.up - rv.down + (right.mean ?? 0.5) * 2) - (lv.up - lv.down + (left.mean ?? 0.5) * 2);
  }), [claims, votes]);

  function vote(id: string, choice: "up" | "down") {
    setVotes(current => {
      const previous = current[id] ?? { up: 0, down: 0, choice: null };
      const next = { ...previous };
      if (previous.choice === choice) {
        next[choice] = Math.max(0, next[choice] - 1);
        next.choice = null;
      } else {
        if (previous.choice) next[previous.choice] = Math.max(0, next[previous.choice] - 1);
        next[choice] += 1;
        next.choice = choice;
      }
      return { ...current, [id]: next };
    });
  }

  if (claimsQ.error) return <SynError message={`Could not load facts: ${(claimsQ.error as Error).message}`} />;
  if (claimsQ.isLoading) return <SynSkeleton rows={5} />;
  if (!claims.length) return <EmptyState icon={Vote} title="No facts to review" description="Promote notes to governed claims first. Those claims become the fact set the team can review here." />;

  const supported = ranked.filter(claim => (votes[claim.id]?.up ?? 0) > (votes[claim.id]?.down ?? 0)).length;
  const contested = ranked.filter(claim => (claim.disagreement ?? 0) > 0.05 || (votes[claim.id]?.down ?? 0) > (votes[claim.id]?.up ?? 0)).length;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section>
        <div className="mb-5 flex items-end justify-between gap-4">
          <div><MonoMeta>Evidence review</MonoMeta><h2 className="mt-1 text-xl font-black text-on-surface">Vote on working facts</h2><p className="mt-1 max-w-2xl text-sm text-on-surface-variant">Votes are team signals, not truth. Confidence and provenance remain governed by the claim evidence.</p></div>
          <span className="font-mono text-xs text-on-surface-variant">{claims.length} facts</span>
        </div>
        <div className="divide-y divide-outline-variant border-y border-outline-variant bg-surface-container-lowest">
          {ranked.map((claim, index) => {
            const value = votes[claim.id] ?? { up: 0, down: 0, choice: null };
            const confidence = Math.round((claim.mean ?? 0.5) * 100);
            return (
              <article key={claim.id} className="grid gap-4 px-4 py-4 md:grid-cols-[36px_minmax(0,1fr)_150px] md:items-center">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-surface-container font-mono text-xs font-bold text-on-surface-variant">{index + 1}</span>
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-black uppercase tracking-[0.12em] text-secondary">{claim.claimType ?? "FACT"}</span><span className="text-[10px] text-on-surface-variant">Confidence {confidence}%</span></div><p className="mt-1 text-sm font-semibold leading-6 text-on-surface">{claim.statement}</p>{claim.riskiestAssumption ? <p className="mt-1 text-xs text-on-surface-variant">Risk: {claim.riskiestAssumption}</p> : null}</div>
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => vote(claim.id, "up")} aria-pressed={value.choice === "up"} className={`inline-flex h-9 min-w-[64px] items-center justify-center gap-1.5 rounded-md border text-xs font-bold ${value.choice === "up" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-outline-variant text-on-surface-variant"}`}><ThumbsUp size={14} />{value.up}</button>
                  <button type="button" onClick={() => vote(claim.id, "down")} aria-pressed={value.choice === "down"} className={`inline-flex h-9 min-w-[64px] items-center justify-center gap-1.5 rounded-md border text-xs font-bold ${value.choice === "down" ? "border-red-400 bg-red-50 text-red-700" : "border-outline-variant text-on-surface-variant"}`}><ThumbsDown size={14} />{value.down}</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <aside className="border-l border-outline-variant pl-5">
        <div className="flex items-center gap-2 text-sm font-black text-on-surface"><Sparkles size={16} className="text-secondary" /> Synthesis brief</div>
        <p className="mt-3 text-sm leading-6 text-on-surface-variant">{projectQ.data?.name ?? "This initiative"} currently has {supported} team-supported fact{supported === 1 ? "" : "s"} and {contested} contested signal{contested === 1 ? "" : "s"}. Validate contested statements before locking the specification.</p>
        <div className="mt-5 space-y-3">
          {ranked.slice(0, 3).map(claim => <div key={claim.id} className="border-l-2 border-emerald-500 pl-3"><div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-emerald-700"><CheckCircle2 size={12} /> Strong signal</div><p className="mt-1 text-xs leading-5 text-on-surface">{claim.statement}</p></div>)}
          {ranked.filter(claim => (claim.disagreement ?? 0) > 0.05).slice(0, 2).map(claim => <div key={claim.id} className="border-l-2 border-amber-500 pl-3"><div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-amber-700"><AlertTriangle size={12} /> Needs evidence</div><p className="mt-1 text-xs leading-5 text-on-surface">{claim.statement}</p></div>)}
        </div>
      </aside>
    </div>
  );
}
