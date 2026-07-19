"use client";

import { useState } from "react";
import { Check, X, AlertTriangle } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { SynButton, SynChip, SynError, SynSkeleton, MonoMeta } from "@/components/synthesis/ui/kit";

/**
 * Review an agent-authored proposal item by item. Accept, reject, or accept-all — the
 * mutation boundary the R1A backend enforces: nothing an agent proposed touches a real
 * record until a human accepts it here, and a STALE item (its base changed) is flagged
 * rather than applied.
 */
interface PItem { id: string; ordinal: number; kind: string; title?: string | null; status: string; targetEntityType?: string | null; targetEntityId?: string | null }
interface Proposal { id: string; status: string; agentRole?: string | null; items: PItem[] }

type Decision = { itemId: string; decision: "ACCEPT" | "REJECT" };

const itemTone = (s: string) => (s === "APPLIED" ? "secondary" : s === "STALE" ? "error" : s === "REJECTED" ? "neutral" : "tertiary");

export function ProposalReview({ proposalId }: { proposalId: string }) {
  const proposal = useSyn<Proposal>(`/synthesis/proposals/${proposalId}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decisions: Decision[]) {
    if (decisions.length === 0) return;
    setBusy(true); setError(null);
    try {
      await workgraphFetch(`/synthesis/proposals/${proposalId}/decide`, { method: "POST", body: JSON.stringify({ decisions }) });
      await proposal.mutate();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not apply the decision."); } finally { setBusy(false); }
  }

  if (proposal.isLoading) return <SynSkeleton rows={2} />;
  if (proposal.error) return <SynError message={proposal.error instanceof Error ? proposal.error.message : "Failed to load proposal."} />;
  const p = proposal.data;
  if (!p) return null;
  const pending = p.items.filter((i) => i.status === "PENDING");

  return (
    <div className="mt-2 rounded-lg border border-outline-variant bg-surface-container-low p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><MonoMeta>proposal · {p.agentRole ?? "agent"}</MonoMeta><SynChip tone={p.status === "ACCEPTED" ? "secondary" : "neutral"}>{p.status}</SynChip></div>
        {pending.length > 0 ? (
          <div className="flex gap-1.5">
            <SynButton variant="secondary" icon={Check} disabled={busy} onClick={() => decide(pending.map((i) => ({ itemId: i.id, decision: "ACCEPT" })))}>Accept all</SynButton>
            <SynButton variant="ghost" icon={X} disabled={busy} onClick={() => decide(pending.map((i) => ({ itemId: i.id, decision: "REJECT" })))}>Reject all</SynButton>
          </div>
        ) : null}
      </div>
      {error ? <SynError message={error} /> : null}
      {p.items.map((it) => (
        <div key={it.id} className="rounded-lg bg-surface-container px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex items-center gap-2">
              <SynChip tone="tertiary" mono>{it.kind}</SynChip>
              <span className="text-xs text-on-surface truncate">{it.title ?? it.targetEntityId ?? ""}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {it.status === "PENDING" ? (
                <>
                  <button type="button" title="Accept" disabled={busy} onClick={() => decide([{ itemId: it.id, decision: "ACCEPT" }])} className="icon-button text-secondary"><Check size={15} /></button>
                  <button type="button" title="Reject" disabled={busy} onClick={() => decide([{ itemId: it.id, decision: "REJECT" }])} className="icon-button text-on-surface-variant"><X size={15} /></button>
                </>
              ) : <SynChip tone={itemTone(it.status)}>{it.status.toLowerCase()}</SynChip>}
            </div>
          </div>
          {it.status === "STALE" ? <p className="mt-1 flex items-center gap-1 text-[11px] text-error"><AlertTriangle size={11} /> Base changed since proposed — rebase to re-apply.</p> : null}
        </div>
      ))}
    </div>
  );
}
