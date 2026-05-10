"use client";
import { use } from "react";
import useSWR from "swr";
import { runtimeApi } from "@/lib/api";

export default function PromptAssemblyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = useSWR(`assembly-${id}`, () => runtimeApi.getAssembly(id));

  if (!data) return <div className="text-slate-500">Loading…</div>;
  const a = data as Record<string, unknown>;
  const layers = (a.layers as Array<Record<string, unknown>>) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Prompt Assembly</h1>
        <div className="font-mono text-xs text-slate-400 mt-1">id: {a.id as string}</div>
        <div className="font-mono text-xs text-slate-400">hash: {a.finalPromptHash as string}</div>
        <div className="text-sm text-slate-600 mt-2">~{a.estimatedInputTokens as number} input tokens · {layers.length} layers</div>
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">Final Prompt Preview</h2>
      <pre className="card p-4 text-xs font-mono text-slate-700 whitespace-pre-wrap mb-6">
{a.finalPromptPreview as string}
      </pre>

      <h2 className="font-semibold text-slate-800 mb-3">Included Layers</h2>
      <div className="space-y-2">
        {layers.map(l => (
          <div key={l.id as string} className="card p-3">
            <div className="flex items-center gap-2 mb-1 text-sm">
              <span className="font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-xs">prio {l.priority as number}</span>
              <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-xs">{l.layerType as string}</span>
              <span className="text-xs text-slate-500">{l.inclusionReason as string}</span>
            </div>
            {!!l.layerHash && <div className="text-[10px] text-slate-400 font-mono mb-1">hash: {(l.layerHash as string).slice(7, 23)}…</div>}
            <pre className="text-xs text-slate-600 font-mono whitespace-pre-wrap">{(l.contentSnapshot as string ?? "").slice(0, 500)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
