"use client";
import useSWR from "swr";
import Link from "next/link";
import { ExternalLink, Info } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const WORKGRAPH_WEB_URL = process.env.NEXT_PUBLIC_WORKGRAPH_WEB_URL ?? "http://localhost:5174";

export default function RuntimeExecutionDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const { data: exec } = useSWR(`exec-${id}`, () => runtimeApi.getExecution(id), { refreshInterval: 3000 });
  const { data: receipt } = useSWR(`exec-receipt-${id}`, () => runtimeApi.getReceipt(id), { refreshInterval: 3000 });

  if (!exec) return <div className="text-slate-500">Loading…</div>;
  const e = exec as Record<string, unknown>;
  const r = (receipt ?? {}) as Record<string, unknown>;
  const at = e.agentTemplate as Record<string, unknown> | undefined;
  const cap = e.capability as Record<string, unknown> | undefined;
  const toolReceipts = (r.toolReceipts as Array<Record<string, unknown>>) ?? [];
  const evidenceRefs = (r.evidenceRefs as Array<Record<string, unknown>>) ?? [];
  const message = r.message as string | null | undefined;

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">Execution {(e.id as string).slice(0, 8)}</h1>
          <StatusBadge value={e.executionStatus as string} />
        </div>
        <div className="font-mono text-xs text-slate-400 mt-2">id: {e.id as string}</div>
        <div className="text-sm text-slate-600 mt-2">{e.userRequest as string}</div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Agent Template</div>
          <div className="text-sm font-medium">{at?.name as string ?? "—"}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Capability</div>
          <div className="text-sm font-medium">{cap?.name as string ?? "—"}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Model</div>
          <div className="text-sm font-mono">{e.modelProvider as string}/{e.modelName as string}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Final status</div>
          <div className="text-sm">{(r.finalStatus as string) ?? (e.executionStatus as string) ?? "—"}</div>
        </div>
      </div>

      {(message || evidenceRefs.length > 0) && (
        <div className="card p-5 mb-6 border-blue-100 bg-blue-50">
          <div className="flex items-start gap-3">
            <Info size={18} className="text-blue-700 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-blue-950">Run this through Workflow Manager</div>
              <p className="text-sm text-blue-900 mt-1">
                {message || "Direct agent-runtime execution is retired. Use a workflow AGENT_TASK for governed execution."}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <a className="btn-secondary text-xs" href={`${WORKGRAPH_WEB_URL}/runs`} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> Open Runs
                </a>
                <a className="btn-primary text-xs" href={`${WORKGRAPH_WEB_URL}/workflows`} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> Workflow Manager
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      <h2 className="font-semibold text-slate-800 mb-3">Receipt</h2>
      <div className="card p-4 mb-6 text-sm space-y-1 font-mono text-xs">
        {r.promptAssemblyId ? (
          <div>prompt assembly: <Link className="text-singularity-600 hover:underline" href={`/prompt-assemblies/${r.promptAssemblyId as string}`}>{r.promptAssemblyId as string}</Link></div>
        ) : null}
        {!!r.promptHash && <div>prompt hash: {r.promptHash as string}</div>}
        {!!r.outputHash && <div>output hash: {r.outputHash as string}</div>}
        {!r.promptAssemblyId && !r.promptHash && !r.outputHash && (
          <div className="font-sans text-slate-500">
            No prompt assembly exists for this legacy direct-runtime row.
          </div>
        )}
      </div>

      {evidenceRefs.length > 0 && (
        <>
          <h2 className="font-semibold text-slate-800 mb-3">Evidence</h2>
          <div className="space-y-2 mb-6">
            {evidenceRefs.map((ref, index) => (
              <div key={`${ref.citation_key as string ?? "evidence"}-${index}`} className="card p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-mono text-xs text-slate-500">{ref.citation_key as string ?? "runtime:evidence"}</span>
                  <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                    {ref.source_kind as string ?? "runtime"}
                  </span>
                </div>
                <p className="text-slate-700">{ref.content as string}</p>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="font-semibold text-slate-800 mb-3">Tool Receipts</h2>
      <div className="space-y-2">
        {toolReceipts.map(tr => (
          <div key={tr.id as string} className="card p-3 text-sm flex items-center gap-3">
            <span className="font-mono">{tr.toolName as string}</span>
            <StatusBadge value={tr.status as string} />
            {!!tr.inputHash && <span className="font-mono text-xs text-slate-400">in: {(tr.inputHash as string).slice(7, 19)}…</span>}
            {!!tr.errorMessage && <span className="text-xs text-red-600">{tr.errorMessage as string}</span>}
          </div>
        ))}
        {toolReceipts.length === 0 && <p className="text-slate-400 text-sm">No tool calls in this execution.</p>}
      </div>
    </div>
  );
}
