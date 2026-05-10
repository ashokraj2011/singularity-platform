"use client";
import { use } from "react";
import useSWR from "swr";
import Link from "next/link";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default function RuntimeExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: exec } = useSWR(`exec-${id}`, () => runtimeApi.getExecution(id), { refreshInterval: 3000 });
  const { data: receipt } = useSWR(`exec-receipt-${id}`, () => runtimeApi.getReceipt(id), { refreshInterval: 3000 });

  if (!exec) return <div className="text-slate-500">Loading…</div>;
  const e = exec as Record<string, unknown>;
  const r = (receipt ?? {}) as Record<string, unknown>;
  const at = e.agentTemplate as Record<string, unknown> | undefined;
  const cap = e.capability as Record<string, unknown> | undefined;
  const toolReceipts = (r.toolReceipts as Array<Record<string, unknown>>) ?? [];

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
          <div className="text-sm">{(r.finalStatus as string) ?? "—"}</div>
        </div>
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">Receipt</h2>
      <div className="card p-4 mb-6 text-sm space-y-1 font-mono text-xs">
        {r.promptAssemblyId ? (
          <div>prompt assembly: <Link className="text-singularity-600 hover:underline" href={`/prompt-assemblies/${r.promptAssemblyId as string}`}>{r.promptAssemblyId as string}</Link></div>
        ) : null}
        {!!r.promptHash && <div>prompt hash: {r.promptHash as string}</div>}
        {!!r.outputHash && <div>output hash: {r.outputHash as string}</div>}
      </div>

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
