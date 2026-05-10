"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { agentApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { BookOpen, CheckCircle, XCircle, Sparkles, Loader2 } from "lucide-react";

const pendingFetcher = () => agentApi.listCandidates(undefined, "pending");
const acceptedFetcher = () => agentApi.listCandidates(undefined, "accepted");

interface Candidate {
  id: string;
  capability_id: string;
  agent_id: string;
  agent_uid: string;
  candidate_type: string;
  content: string;
  confidence: number;
  importance: number;
  source_type: string;
  session_id?: string;
  status: string;
}

interface AcceptedGroup {
  key: string;
  capability_id: string;
  agent_id: string;
  agent_uid: string;
  candidate_type: string;
  candidates: Candidate[];
}

export default function LearningPage() {
  const { data: pendingData, isLoading: loadingPending, mutate: mutatePending } =
    useSWR("learning-pending", pendingFetcher);
  const { data: acceptedData, isLoading: loadingAccepted, mutate: mutateAccepted } =
    useSWR("learning-accepted", acceptedFetcher);

  const pending = (pendingData?.candidates ?? []) as unknown as Candidate[];
  const accepted = (acceptedData?.candidates ?? []) as unknown as Candidate[];

  // Group accepted by (capability, agent_uid, candidate_type) so the operator
  // distils per cohort instead of one-by-one.
  const groups = useMemo<AcceptedGroup[]>(() => {
    const map = new Map<string, AcceptedGroup>();
    for (const c of accepted) {
      const key = `${c.capability_id}:${c.agent_uid}:${c.candidate_type}`;
      const g = map.get(key);
      if (g) g.candidates.push(c);
      else map.set(key, {
        key,
        capability_id: c.capability_id,
        agent_id: c.agent_id,
        agent_uid: c.agent_uid,
        candidate_type: c.candidate_type,
        candidates: [c],
      });
    }
    return Array.from(map.values()).sort((a, b) => b.candidates.length - a.candidates.length);
  }, [accepted]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ key: string; written: number } | null>(null);

  async function handleReview(id: string, decision: "accepted" | "rejected") {
    await agentApi.reviewCandidate(id, decision);
    await Promise.all([mutatePending(), mutateAccepted()]);
  }

  async function handleDistill(g: AcceptedGroup) {
    setBusyKey(g.key); setError(null);
    try {
      const out = await agentApi.distillCandidates({
        capability_id: g.capability_id,
        agent_uid: g.agent_uid,
        candidate_type: g.candidate_type,
        candidate_ids: g.candidates.map((c) => c.id),
      });
      setLastResult({ key: g.key, written: out.written });
      await mutateAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Distillation failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Learning Review</h1>
        <p className="text-slate-500 mt-1">
          Review pending observations, then distill accepted ones into reusable memory.
        </p>
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-800 rounded-md px-3 py-2 text-sm">{error}</div>
      )}
      {lastResult && (
        <div className="border border-emerald-200 bg-emerald-50 text-emerald-800 rounded-md px-3 py-2 text-sm">
          Distilled <strong>{lastResult.written}</strong> memory entries from cohort <code>{lastResult.key}</code>.
        </div>
      )}

      {/* ── Pending review section ─────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Pending review ({pending.length})</h2>
        {loadingPending && <div className="text-slate-500 text-sm">Loading…</div>}
        <div className="space-y-3">
          {pending.map((cr) => (
            <div key={cr.id} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-indigo-50 rounded-lg shrink-0">
                <BookOpen size={18} className="text-indigo-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-mono text-xs text-slate-500">{cr.capability_id}:{cr.agent_id}</span>
                  <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{cr.candidate_type}</span>
                  <StatusBadge value={cr.status} />
                  <span className="text-xs text-slate-400">conf: {cr.confidence} · imp: {cr.importance}</span>
                </div>
                <p className="text-sm text-slate-800">{cr.content}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => handleReview(cr.id, "accepted")} className="text-emerald-600 hover:text-emerald-700" title="Accept">
                  <CheckCircle size={22} />
                </button>
                <button onClick={() => handleReview(cr.id, "rejected")} className="text-red-500 hover:text-red-600" title="Reject">
                  <XCircle size={22} />
                </button>
              </div>
            </div>
          ))}
          {!loadingPending && pending.length === 0 && (
            <div className="card p-8 text-center text-slate-400 text-sm">No pending candidates.</div>
          )}
        </div>
      </section>

      {/* ── Accepted, awaiting distillation ────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Ready to distil ({accepted.length} candidates · {groups.length} cohorts)</h2>
        {loadingAccepted && <div className="text-slate-500 text-sm">Loading…</div>}
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.key} className="card p-5">
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-slate-500">{g.capability_id}:{g.agent_id}</span>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded font-medium">{g.candidate_type}</span>
                    <span className="text-xs text-slate-500">{g.candidates.length} accepted observation{g.candidates.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDistill(g)}
                  disabled={busyKey === g.key}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                >
                  {busyKey === g.key ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {busyKey === g.key ? "Distilling…" : "Distill into memory"}
                </button>
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {g.candidates.map((c) => (
                  <div key={c.id} className="text-xs text-slate-700 bg-slate-50 rounded px-2 py-1">
                    {c.content}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!loadingAccepted && groups.length === 0 && (
            <div className="card p-8 text-center text-slate-400 text-sm">
              No accepted candidates yet. Accept some above to see cohorts here.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
