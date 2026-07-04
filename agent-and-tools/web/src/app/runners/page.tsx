"use client";
import useSWR from "swr";
import { Users } from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { apiPath, assertValidApiResponse, readResponseBody, responseMessage } from "@/lib/api";
import { asDateTime, asRow, asRowArray, asString, asStringArray, type Row } from "@/lib/row";

const fetcher = async () => {
  const res = await fetch(apiPath("/api/client-runners"));
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  assertValidApiResponse("/api/client-runners", raw, parseError);
  return { runners: asRowArray(asRow(parsed).runners) };
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
        {runners.map((runner: Row, index: number) => {
          const caps = asRow(runner.capabilities);
          const id = asString(runner.id, `runner-${index}`);
          const name = asString(runner.runner_name, id);
          const type = asString(runner.runner_type);
          const tools = asStringArray(caps.tools);
          const providers = asStringArray(caps.providers);
          return (
            <div key={id} className="card p-5 flex items-start gap-4">
              <div className="p-2.5 bg-amber-50 rounded-lg shrink-0">
                <Users size={20} className="text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-slate-900">{name}</span>
                  <StatusBadge value={asString(runner.status, "unknown")} />
                  {!!type && (
                    <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{type}</span>
                  )}
                </div>
                <div className="font-mono text-xs text-slate-500 mb-2">{id}</div>
                {(tools.length > 0 || providers.length > 0) && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {tools.map((tool, toolIndex) => (
                      <span key={`${tool}-${toolIndex}`} className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{tool}</span>
                    ))}
                    {providers.map((provider, providerIndex) => (
                      <span key={`${provider}-${providerIndex}`} className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded">{provider}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-xs text-slate-400 shrink-0">
                {asString(runner.last_seen_at) ? `Last seen: ${asDateTime(runner.last_seen_at)}` : "Never seen"}
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
