"use client";
import { useState } from "react";
import useSWR from "swr";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus } from "lucide-react";

export default function PromptProfileDetailPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const { data: profile, mutate } = useSWR(`profile-${id}`, () => runtimeApi.getProfile(id));
  const { data: allLayers } = useSWR("all-layers", () => runtimeApi.listLayers());
  const [layerId, setLayerId] = useState("");
  const [priority, setPriority] = useState(100);

  async function attach() {
    if (!layerId) return;
    await runtimeApi.attachLayerToProfile(id, { promptLayerId: layerId, priority, isEnabled: true } as never);
    setLayerId("");
    await mutate();
  }

  if (!profile) return <div className="text-slate-500">Loading…</div>;
  const p = profile as Record<string, unknown>;
  const layers = (p.layers as Array<Record<string, unknown>>) ?? [];
  const layerOptions = (allLayers ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{p.name as string}</h1>
          <StatusBadge value={p.status as string} />
          {!!p.ownerScopeType && <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{p.ownerScopeType as string}</span>}
        </div>
        {!!p.description && <p className="text-sm text-slate-600 mt-2">{p.description as string}</p>}
        <div className="font-mono text-xs text-slate-400 mt-2">id: {p.id as string}</div>
      </div>

      <div className="card p-4 mb-4 flex gap-2 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-600 mb-1">Add Layer</label>
          <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            value={layerId} onChange={e => setLayerId(e.target.value)}>
            <option value="">— pick a layer —</option>
            {layerOptions.map(l => (
              <option key={l.id as string} value={l.id as string}>
                [{l.layerType as string}] {l.name as string}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Priority</label>
          <input type="number" className="w-24 px-3 py-2 border border-slate-200 rounded-lg text-sm"
            value={priority} onChange={e => setPriority(Number(e.target.value))} />
        </div>
        <button className="btn-primary" onClick={attach}><Plus size={14} /> Attach</button>
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">Layers (sorted by priority)</h2>
      <div className="space-y-2">
        {layers.map(link => {
          const layer = link.promptLayer as Record<string, unknown>;
          return (
            <div key={link.id as string} className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-1 rounded">prio {link.priority as number}</span>
                <span className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">{layer.layerType as string}</span>
                <span className="font-medium text-slate-800 text-sm">{layer.name as string}</span>
                {!!link.isEnabled && <span className="text-xs text-emerald-700">enabled</span>}
              </div>
              <p className="text-xs text-slate-500 line-clamp-3 font-mono">{layer.content as string}</p>
            </div>
          );
        })}
        {layers.length === 0 && <p className="text-slate-400 text-sm">No layers attached.</p>}
      </div>
    </div>
  );
}
