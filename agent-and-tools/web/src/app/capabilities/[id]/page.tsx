"use client";
import { use, useState } from "react";
import useSWR from "swr";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus } from "lucide-react";

export default function CapabilityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: cap, mutate: mutateCap } = useSWR(`cap-${id}`, () => runtimeApi.getCapability(id));
  const { data: templates } = useSWR("runtime-tmpl-options", () => runtimeApi.listTemplates());

  const [tab, setTab] = useState<"bindings" | "repos" | "knowledge">("bindings");

  // Forms
  const [repo, setRepo] = useState({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
  const [bind, setBind] = useState({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
  const [know, setKnow] = useState({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });

  if (!cap) return <div className="text-slate-500">Loading…</div>;
  const c = cap as Record<string, unknown>;
  const repos = (c.repositories as Array<Record<string, unknown>>) ?? [];
  const bindings = (c.bindings as Array<Record<string, unknown>>) ?? [];
  const know_artifacts = (c.knowledgeArtifacts as Array<Record<string, unknown>>) ?? [];

  async function addRepo() {
    if (!repo.repoName || !repo.repoUrl) return;
    await runtimeApi.attachRepo(id, repo as never);
    setRepo({ repoName: "", repoUrl: "", defaultBranch: "main", repositoryType: "GITHUB" });
    await mutateCap();
  }

  async function addBinding() {
    if (!bind.agentTemplateId || !bind.bindingName) return;
    await runtimeApi.bindAgent(id, bind as never);
    setBind({ agentTemplateId: "", bindingName: "", roleInCapability: "" });
    await mutateCap();
  }

  async function addKnowledge() {
    if (!know.title || !know.content) return;
    await runtimeApi.addKnowledge(id, know as never);
    setKnow({ artifactType: "ARCHITECTURE_SUMMARY", title: "", content: "", confidence: 0.8 });
    await mutateCap();
  }

  const tmplOptions = (templates?.items ?? []) as Record<string, unknown>[];

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{c.name as string}</h1>
          <StatusBadge value={c.status as string} />
        </div>
        {!!c.description && <p className="text-sm text-slate-600 mt-2">{c.description as string}</p>}
        <div className="font-mono text-xs text-slate-400 mt-2">id: {c.id as string}</div>
      </div>

      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(["bindings", "repos", "knowledge"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t ? "border-singularity-600 text-singularity-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}>{t}</button>
        ))}
      </div>

      {tab === "bindings" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Agent Template</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={bind.agentTemplateId} onChange={e => setBind(b => ({ ...b, agentTemplateId: e.target.value }))}>
                <option value="">—</option>
                {tmplOptions.map(t => <option key={t.id as string} value={t.id as string}>{t.name as string} ({t.roleType as string})</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Binding name</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="CCRE Architect Agent"
                value={bind.bindingName} onChange={e => setBind(b => ({ ...b, bindingName: e.target.value }))} />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-600 mb-1">Role in capability</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="CAPABILITY_ARCHITECT"
                value={bind.roleInCapability} onChange={e => setBind(b => ({ ...b, roleInCapability: e.target.value }))} />
            </div>
            <button className="btn-primary" onClick={addBinding}><Plus size={14} /> Bind</button>
          </div>

          <div className="space-y-2">
            {bindings.map(b => {
              const at = b.agentTemplate as Record<string, unknown>;
              return (
                <div key={b.id as string} className="card p-4 text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-slate-800">{b.bindingName as string}</span>
                    <StatusBadge value={b.status as string} />
                    <span className="text-xs text-slate-500">{at?.name as string}</span>
                  </div>
                  <div className="font-mono text-xs text-slate-400">id: {b.id as string}</div>
                </div>
              );
            })}
            {bindings.length === 0 && <p className="text-slate-400 text-sm">No bindings yet.</p>}
          </div>
        </div>
      )}

      {tab === "repos" && (
        <div>
          <div className="card p-4 mb-4 flex gap-2 items-end">
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="repo name" value={repo.repoName} onChange={e => setRepo(r => ({ ...r, repoName: e.target.value }))} />
            <input className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="https://github.com/org/repo"
              value={repo.repoUrl} onChange={e => setRepo(r => ({ ...r, repoUrl: e.target.value }))} />
            <button className="btn-primary" onClick={addRepo}><Plus size={14} /> Attach</button>
          </div>
          <div className="space-y-2">
            {repos.map(r => (
              <div key={r.id as string} className="card p-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{r.repoName as string}</span>
                  <span className="text-xs text-slate-500">{r.defaultBranch as string}</span>
                </div>
                <a href={r.repoUrl as string} className="text-xs text-singularity-600 hover:underline" target="_blank" rel="noreferrer">{r.repoUrl as string}</a>
              </div>
            ))}
            {repos.length === 0 && <p className="text-slate-400 text-sm">No repositories attached.</p>}
          </div>
        </div>
      )}

      {tab === "knowledge" && (
        <div>
          <div className="card p-4 mb-4 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="artifactType (e.g. ARCHITECTURE_SUMMARY)"
                value={know.artifactType} onChange={e => setKnow(k => ({ ...k, artifactType: e.target.value }))} />
              <input className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="title"
                value={know.title} onChange={e => setKnow(k => ({ ...k, title: e.target.value }))} />
            </div>
            <textarea rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="content"
              value={know.content} onChange={e => setKnow(k => ({ ...k, content: e.target.value }))} />
            <button className="btn-primary" onClick={addKnowledge}><Plus size={14} /> Add Artifact</button>
          </div>
          <div className="space-y-2">
            {know_artifacts.map(a => (
              <div key={a.id as string} className="card p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{a.artifactType as string}</span>
                  <span className="font-medium text-slate-800 text-sm">{a.title as string}</span>
                </div>
                <p className="text-sm text-slate-600">{a.content as string}</p>
              </div>
            ))}
            {know_artifacts.length === 0 && <p className="text-slate-400 text-sm">No knowledge artifacts.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
