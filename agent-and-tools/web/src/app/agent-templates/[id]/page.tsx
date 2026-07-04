"use client";
import useSWR from "swr";
import { useParams } from "next/navigation";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { asBoolean, asRow, asRowArray, asString, type Row } from "@/lib/row";

export default function AgentTemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const { data: tmpl } = useSWR(`tmpl-${id}`, () => runtimeApi.getTemplate(id));

  if (!tmpl) return <div className="text-slate-500">Loading…</div>;
  const t = asRow(tmpl);
  const skills = asRowArray(t.skills);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{asString(t.name, "Untitled agent template")}</h1>
          <StatusBadge value={asString(t.status, "unknown")} />
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{asString(t.roleType, "role pending")}</span>
        </div>
        {!!asString(t.description) && <p className="text-sm text-slate-600 mt-2">{asString(t.description)}</p>}
        <div className="text-xs text-slate-400 mt-2 font-mono">id: {asString(t.id, id)}</div>
        {!!asString(t.basePromptProfileId) && (
          <div className="text-xs text-slate-400 mt-1 font-mono">base profile: {asString(t.basePromptProfileId)}</div>
        )}
      </div>

      <h2 className="font-semibold text-slate-800 mb-3">Skills</h2>
      <div className="space-y-2">
        {skills.map((s: Row, index: number) => {
          const sk = asRow(s.skill);
          const skillName = asString(sk.name, asString(s.skillId, `Skill ${index + 1}`));
          return (
            <div key={asString(s.id, `${skillName}-${index}`)} className="card p-4 flex items-center gap-3 text-sm">
              <span className="font-medium text-slate-800">{skillName}</span>
              <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{asString(sk.skillType, "skill")}</span>
              {asBoolean(s.isDefault) && <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">default</span>}
            </div>
          );
        })}
        {skills.length === 0 && <p className="text-slate-400 text-sm">No skills attached.</p>}
      </div>
    </div>
  );
}
