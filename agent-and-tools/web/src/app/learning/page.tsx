"use client";
import useSWR from "swr";
import { agentApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { BookOpen, CheckCircle, XCircle } from "lucide-react";

const fetcher = () => agentApi.listCandidates(undefined, "pending");

export default function LearningPage() {
  const { data, isLoading, mutate } = useSWR("all-candidates", fetcher);
  const candidates = data?.candidates ?? [];

  async function handleReview(id: string, decision: "accepted" | "rejected") {
    await agentApi.reviewCandidate(id, decision);
    await mutate();
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Learning Review</h1>
        <p className="text-slate-500 mt-1">Review and approve pending learning candidates across all agents</p>
      </div>

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {candidates.map((c) => {
          const cr = c as Record<string, unknown>;
          return (
            <div key={cr.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-indigo-50 rounded-lg shrink-0">
                <BookOpen size={18} className="text-indigo-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-mono text-xs text-slate-500">{cr.capability_id as string}:{cr.agent_id as string}</span>
                  <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{cr.candidate_type as string}</span>
                  <StatusBadge value={cr.status as string} />
                  <span className="text-xs text-slate-400">conf: {cr.confidence as number} · imp: {cr.importance as number}</span>
                </div>
                <p className="text-sm text-slate-800">{cr.content as string}</p>
                <div className="text-xs text-slate-400 mt-1">
                  Source: {cr.source_type as string}{cr.session_id ? ` · session: ${cr.session_id as string}` : ""}
                </div>
              </div>
              {cr.status === "pending" && (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => handleReview(cr.id as string, "accepted")}
                    className="text-emerald-600 hover:text-emerald-700" title="Accept">
                    <CheckCircle size={22} />
                  </button>
                  <button onClick={() => handleReview(cr.id as string, "rejected")}
                    className="text-red-500 hover:text-red-600" title="Reject">
                    <XCircle size={22} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!isLoading && candidates.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <BookOpen size={40} className="mx-auto mb-3 opacity-40" />
            <p>No pending learning candidates. All caught up!</p>
          </div>
        )}
      </div>
    </div>
  );
}
