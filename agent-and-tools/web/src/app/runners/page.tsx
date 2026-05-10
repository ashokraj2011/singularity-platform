"use client";
import useSWR from "swr";
import { Users } from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";

const fetcher = async () => {
  const res = await fetch("/api/client-runners");
  return res.json() as Promise<{ runners: Record<string, unknown>[] }>;
};

export default function RunnersPage() {
  const { data, isLoading } = useSWR("runners", fetcher, { refreshInterval: 10000 });
  const runners = data?.runners ?? [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Client Runners</h1>
        <p className="text-slate-500 mt-1">Local runners that execute tools on developer machines</p>
      </div>

      {isLoading && <div className="text-slate-500 text-sm">Loading…</div>}

      <div className="space-y-3">
        {runners.map((r) => {
          const runner = r as Record<string, unknown>;
          const caps = runner.capabilities as Record<string, unknown>;
          return (
            <div key={runner.id as string} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-amber-50 rounded-lg shrink-0">
                <Users size={20} className="text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-slate-900">{(runner.runner_name ?? runner.id) as string}</span>
                  <StatusBadge value={runner.status as string} />
                  {!!runner.runner_type && (
                    <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{runner.runner_type as string}</span>
                  )}
                </div>
                <div className="font-mono text-xs text-slate-500 mb-2">{runner.id as string}</div>
                {!!caps && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {(caps.tools as string[] | undefined)?.map((t) => (
                      <span key={t} className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{t}</span>
                    ))}
                    {(caps.providers as string[] | undefined)?.map((p) => (
                      <span key={p} className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{p}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-xs text-slate-400 shrink-0">
                {runner.last_seen_at
                  ? `Last seen: ${new Date(runner.last_seen_at as string).toLocaleTimeString()}`
                  : "Never seen"}
              </div>
            </div>
          );
        })}
        {!isLoading && runners.length === 0 && (
          <div className="card p-12 text-center text-slate-400">
            <Users size={40} className="mx-auto mb-3 opacity-40" />
            <p>No runners registered. Start a local runner to see it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
