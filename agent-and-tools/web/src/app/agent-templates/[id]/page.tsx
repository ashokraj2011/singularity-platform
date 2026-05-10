"use client";
import { use } from "react";
import useSWR from "swr";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

export default function AgentTemplateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: tmpl } = useSWR(`tmpl-${id}`, () => runtimeApi.getTemplate(id));

  if (!tmpl) return <div className="text-slate-500">Loading…</div>;
  const t = tmpl as Record<string, unknown>;
  const skills = (t.skills as Array<Record<string, unknown>>) ?? [];

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{t.name as string}</h1>
          <StatusBadge value={t.status as string} />
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{t.roleType as string}</span>
        </div>
        {!!t.description && <p className="text-sm text-slate-600 mt-2">{t.description as string}</p>}
        <div className="text-xs text-slate-400 mt-2 font-mono">id: {t.id as string}</div>
        {!!t.basePromptProfileId && (
          <div className="text-xs text-slate-400 mt-1 font-mono">base profile: {t.basePromptProfileId as string}</div>
        )}
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">Skills</h2>
      <div className="space-y-2">
        {skills.map(s => {
          const sk = s.skill as Record<string, unknown>;
          return (
            <div key={s.id as string} className="card p-4 flex items-center gap-3 text-sm">
              <span className="font-medium text-slate-800">{sk.name as string}</span>
              <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{sk.skillType as string}</span>
              {!!s.isDefault && <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">default</span>}
            </div>
          );
        })}
        {skills.length === 0 && <p className="text-slate-400 text-sm">No skills attached.</p>}
      </div>
    </div>
  );
}
