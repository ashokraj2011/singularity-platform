"use client";
import useSWR from "swr";
import Link from "next/link";
import { Activity, ExternalLink, Info } from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const WORKGRAPH_WEB_URL = process.env.NEXT_PUBLIC_WORKGRAPH_WEB_URL ?? "http://localhost:5174";

export default function RuntimeExecutionsPage() {
  const { data: execs, isLoading } = useSWR("runtime-executions", () => runtimeApi.listExecutions(), { refreshInterval: 5000 });
  const items = (execs ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Runtime Receipts</h1>
          <p className="text-slate-500 mt-1">Historical direct-runtime receipts · workflow execution now lives in Workflow Manager.</p>
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary" href={`${WORKGRAPH_WEB_URL}/runs`} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> Open Runs
          </a>
          <a className="btn-primary" href={`${WORKGRAPH_WEB_URL}/workflows`} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> Workflow Manager
          </a>
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
        {items.map(e => {
          const at = e.agentTemplate as Record<string, unknown> | undefined;
          const cap = e.capability as Record<string, unknown> | undefined;
          return (
            <div key={e.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-emerald-50 rounded-lg shrink-0">
                <Activity size={18} className="text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-medium text-slate-900">{at?.name as string ?? "—"}</span>
                  <StatusBadge value={e.executionStatus as string} />
                  {!!cap && <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{cap.name as string}</span>}
                  <span className="text-xs text-slate-400 font-mono">{e.modelProvider as string}/{e.modelName as string}</span>
                </div>
                <p className="text-sm text-slate-700">{e.userRequest as string}</p>
                <div className="text-xs text-slate-400 mt-1">{new Date(e.createdAt as string).toLocaleString()}</div>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <Link href={`/runtime-executions/${e.id}`} className="btn-secondary text-xs">View receipt</Link>
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
