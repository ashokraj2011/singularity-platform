"use client";
import useSWR from "swr";
import Link from "next/link";
import { Activity, Info, Workflow } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { asDateTime, asRow, asRowArray, asString, type Row } from "@/lib/row";

export default function RuntimeExecutionsPage() {
  const { data: execs, isLoading } = useSWR("runtime-executions", () => runtimeApi.listExecutions(), { refreshInterval: 5000 });
  const items = asRowArray(execs);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Runtime Receipts</h1>
          <p className="text-slate-500 mt-1">Historical direct-runtime receipts · workflow execution now lives in Workflow Manager.</p>
        </div>
        <div className="flex gap-2">
          <Link className="btn-secondary" href="/runs">
            <Activity size={16} /> Open Runs
          </Link>
          <Link className="btn-primary" href="/workflows">
            <Workflow size={16} /> Workflow Manager
          </Link>
        </div>
      </div>

      <div className="card p-5 mb-6 border-blue-100 bg-blue-50">
        <div className="flex items-start gap-3">
          <Info size={18} className="text-blue-700 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold text-blue-950">Direct agent-runtime runs are retired.</div>
            <p className="text-sm text-blue-900 mt-1">
              Start agent work from a workflow AGENT_TASK. That path enforces Prompt Composer context plans,
              Context Fabric/MCP execution, model aliases, budgets, approvals, artifacts, and Run Insights.
            </p>
          </div>
        </div>
      </div>

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {items.map((e: Row, index: number) => {
          const at = asRow(e.agentTemplate);
          const cap = asRow(e.capability);
          const id = asString(e.id, `execution-${index}`);
          const model = [asString(e.modelProvider), asString(e.modelName)].filter(Boolean).join("/") || "model pending";
          const capabilityName = asString(cap.name);
          return (
            <div key={id} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-emerald-50 rounded-lg shrink-0">
                <Activity size={18} className="text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{asString(at.name, "Untitled execution")}</span>
                  <StatusBadge value={asString(e.executionStatus, "unknown")} />
                  {!!capabilityName && <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{capabilityName}</span>}
                  <span className="text-xs text-slate-400 font-mono">{model}</span>
                </div>
                <p className="text-sm text-slate-700">{asString(e.userRequest, "No request captured.")}</p>
                <div className="text-xs text-slate-400 mt-1">{asDateTime(e.createdAt)}</div>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <Link href={`/runtime-executions/${encodeURIComponent(id)}`} className="btn-secondary text-xs">View receipt</Link>
              </div>
            </div>
          );
        })}
        {!isLoading && items.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Activity size={40} className="mx-auto mb-3 opacity-40" />
            <p>No executions yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
