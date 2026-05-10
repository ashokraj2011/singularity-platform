"use client";
import useSWR from "swr";
import { toolApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Play } from "lucide-react";

const fetcher = () => toolApi.executions();

export default function ExecutionsPage() {
  const { data, isLoading } = useSWR("executions", fetcher, { refreshInterval: 5000 });
  const executions = data?.executions ?? [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Tool Executions</h1>
        <p className="text-slate-500 mt-1">Live execution log — auto-refreshes every 5s</p>
      </div>

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-4 py-3 font-medium text-slate-600">Tool</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">Capability</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">Location</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {executions.map((ex) => {
              const e = ex as Record<string, unknown>;
              return (
                <tr key={e.id as string} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-800">{e.tool_name as string}</td>
                  <td className="px-4 py-3 text-slate-600">{e.capability_id as string}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{e.execution_location as string}</td>
                  <td className="px-4 py-3"><StatusBadge value={e.status as string} /></td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {new Date(e.started_at as string).toLocaleString()}
                  </td>
                </tr>
              );
            })}
            {!isLoading && executions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-slate-400">
                  <Play size={32} className="mx-auto mb-2 opacity-40" />
                  No executions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
