"use client";
import { useState } from "react";
import useSWR from "swr";
import { Brain, CheckCircle, XCircle, ArrowUp } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default function MemoryPage() {
  const { data: execMem, mutate: mutExec } = useSWR("runtime-exec-memory", () => runtimeApi.listExecutionMemory(), { refreshInterval: 5000 });
  const { data: distilled, mutate: mutDist } = useSWR("runtime-distilled", () => runtimeApi.listDistilled(), { refreshInterval: 5000 });

  const [tab, setTab] = useState<"execution" | "distilled">("execution");

  async function review(id: string, decision: "APPROVED" | "REJECTED" | "CANDIDATE") {
    await runtimeApi.reviewMemory(id, decision);
    await mutExec();
  }

  async function promote(mem: Record<string, unknown>) {
    await runtimeApi.promoteMemory({
      sourceMemoryIds: [mem.id as string],
      scopeType: "CAPABILITY",
      scopeId: (mem.capabilityId as string) ?? "global",
      memoryType: mem.memoryType as string,
      title: (mem.title as string) ?? "Promoted memory",
      content: mem.content as string,
      confidence: mem.confidence as number | undefined,
    } as never);
    await mutExec(); await mutDist();
  }

  const exec = (execMem ?? []) as Record<string, unknown>[];
  const dist = (distilled ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Memory</h1>
        <p className="text-slate-500 mt-1">Execution memory becomes distilled memory through review and promotion.</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(["execution", "distilled"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t ? "border-singularity-600 text-singularity-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}>{t}</button>
        ))}
      </div>

      {tab === "execution" && (
        <div className="space-y-3">
          {exec.map(m => (
            <div key={m.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-indigo-50 rounded-lg shrink-0"><Brain size={18} className="text-indigo-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{(m.title as string) ?? "(untitled)"}</span>
                  <StatusBadge value={m.promotionStatus as string} />
                  <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">{m.memoryType as string}</span>
                  {!!m.confidence && <span className="text-xs text-slate-500">conf: {String(m.confidence)}</span>}
                </div>
                <p className="text-sm text-slate-700">{m.content as string}</p>
                <div className="text-xs text-slate-400 mt-1">workflow: {m.workflowExecutionId as string}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                {m.promotionStatus === "NOT_REVIEWED" && (
                  <>
                    <button onClick={() => review(m.id as string, "APPROVED")} className="text-emerald-600 hover:text-emerald-700" title="Approve">
                      <CheckCircle size={20} />
                    </button>
                    <button onClick={() => review(m.id as string, "REJECTED")} className="text-red-500 hover:text-red-600" title="Reject">
                      <XCircle size={20} />
                    </button>
                  </>
                )}
                {(m.promotionStatus === "APPROVED" || m.promotionStatus === "CANDIDATE") && (
                  <button onClick={() => promote(m)} className="btn-primary text-xs"><ArrowUp size={14} /> Promote</button>
                )}
              </div>
            </div>
          ))}
          {exec.length === 0 && (
            <div className="card p-12 text-center text-slate-400">
              <Brain size={40} className="mx-auto mb-3 opacity-40" />
              <p>No execution memory yet.</p>
            </div>
          )}
        </div>
      )}

      {tab === "distilled" && (
        <div className="space-y-3">
          {dist.map(m => (
            <div key={m.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-emerald-50 rounded-lg shrink-0"><Brain size={18} className="text-emerald-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{m.title as string}</span>
                  <StatusBadge value={m.status as string} />
                  <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">{m.memoryType as string}</span>
                  <span className="text-xs text-slate-500">v{m.version as number}</span>
                </div>
                <p className="text-sm text-slate-700">{m.content as string}</p>
                <div className="text-xs text-slate-400 mt-1">scope: {m.scopeType as string} / {m.scopeId as string}</div>
              </div>
            </div>
          ))}
          {dist.length === 0 && (
            <div className="card p-12 text-center text-slate-400">
              <Brain size={40} className="mx-auto mb-3 opacity-40" />
              <p>No distilled memory yet. Approve and promote execution memory to populate.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
