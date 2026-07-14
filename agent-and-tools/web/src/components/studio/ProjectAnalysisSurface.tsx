"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import useSWR from "swr";
import { Plus, X, Save } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { patchSection, specKey, type Goal, type ProjectSpec, type Stakeholder } from "./projectSpec";

/**
 * Project-level Analysis — the shared problem framing that many work items build on. Authored once
 * at the project (not per Work Item). Saves the whole `analysis` section with the loaded revision;
 * the API 409s if someone else saved in the meantime.
 */
export function ProjectAnalysisSurface({ projectId }: { projectId: string }) {
  const { data: spec, error, isLoading, mutate } = useSWR<ProjectSpec>(specKey(projectId), (url: string) => workgraphFetch<ProjectSpec>(url));

  const [problem, setProblem] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [assumptionsText, setAssumptionsText] = useState("");
  const [constraintsText, setConstraintsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed local state whenever a new revision arrives (initial load, or after our own save).
  useEffect(() => {
    if (!spec) return;
    const a = spec.package.analysis;
    setProblem(a.problem ?? "");
    setGoals(a.goals ?? []);
    setStakeholders(a.stakeholders ?? []);
    setAssumptionsText((a.assumptions ?? []).join("\n"));
    setConstraintsText((a.constraints ?? []).join("\n"));
  }, [spec?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!spec) return;
    setSaving(true); setSaveError(null);
    const analysis = {
      problem: problem.trim(),
      goals: goals.filter((g) => g.text.trim()).map((g) => ({ text: g.text.trim(), ...(g.metric?.trim() ? { metric: g.metric.trim() } : {}) })),
      stakeholders: stakeholders.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), ...(s.role?.trim() ? { role: s.role.trim() } : {}), ...(s.concern?.trim() ? { concern: s.concern.trim() } : {}) })),
      assumptions: assumptionsText.split("\n").map((s) => s.trim()).filter(Boolean),
      constraints: constraintsText.split("\n").map((s) => s.trim()).filter(Boolean),
    };
    try {
      await mutate(patchSection(projectId, "analysis", analysis, spec.revision), { revalidate: false });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save. Reload and try again.");
      mutate();
    } finally { setSaving(false); }
  }

  if (isLoading) return <p style={muted}>Loading…</p>;
  if (error || !spec) return <div className="card" style={{ padding: 16, ...muted }}>Couldn&apos;t load the project analysis. <button className="btn-secondary text-xs" onClick={() => mutate()} style={{ marginLeft: 8 }}>Retry</button></div>;

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 860 }}>
      <SaveBar section="Analysis" revision={spec.revision} saving={saving} savedAt={savedAt} onSave={save} error={saveError} />

      <Field label="Problem">
        <textarea value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="What's broken, and why does it matter — to the customer and the business?"
          style={{ ...inputStyle, minHeight: 84, resize: "vertical" }} />
      </Field>

      <Field label="Goals" onAdd={() => setGoals((g) => [...g, { text: "" }])}>
        {goals.length === 0 && <Empty>No goals yet.</Empty>}
        {goals.map((g, i) => (
          <div key={i} style={rowStyle}>
            <input value={g.text} onChange={(e) => setGoals((arr) => patch(arr, i, { text: e.target.value }))} placeholder="Goal" style={{ ...inputStyle, flex: 2 }} />
            <input value={g.metric ?? ""} onChange={(e) => setGoals((arr) => patch(arr, i, { metric: e.target.value }))} placeholder="Metric (e.g. fail<0.5%)" style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono, monospace)" }} />
            <RemoveBtn onClick={() => setGoals((arr) => arr.filter((_, j) => j !== i))} />
          </div>
        ))}
      </Field>

      <Field label="Stakeholders" onAdd={() => setStakeholders((s) => [...s, { name: "" }])}>
        {stakeholders.length === 0 && <Empty>No stakeholders yet.</Empty>}
        {stakeholders.map((s, i) => (
          <div key={i} style={rowStyle}>
            <input value={s.name} onChange={(e) => setStakeholders((arr) => patch(arr, i, { name: e.target.value }))} placeholder="Name" style={{ ...inputStyle, flex: 1 }} />
            <input value={s.role ?? ""} onChange={(e) => setStakeholders((arr) => patch(arr, i, { role: e.target.value }))} placeholder="Role" style={{ ...inputStyle, flex: 1 }} />
            <input value={s.concern ?? ""} onChange={(e) => setStakeholders((arr) => patch(arr, i, { concern: e.target.value }))} placeholder="Concern" style={{ ...inputStyle, flex: 2 }} />
            <RemoveBtn onClick={() => setStakeholders((arr) => arr.filter((_, j) => j !== i))} />
          </div>
        ))}
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Field label="Assumptions">
          <textarea value={assumptionsText} onChange={(e) => setAssumptionsText(e.target.value)} placeholder="One per line" style={{ ...inputStyle, minHeight: 96, resize: "vertical" }} />
        </Field>
        <Field label="Constraints">
          <textarea value={constraintsText} onChange={(e) => setConstraintsText(e.target.value)} placeholder="One per line" style={{ ...inputStyle, minHeight: 96, resize: "vertical" }} />
        </Field>
      </div>
    </div>
  );
}

function patch<T>(arr: T[], i: number, next: Partial<T>): T[] {
  return arr.map((item, j) => (j === i ? { ...item, ...next } : item));
}

export function SaveBar({ section, revision, saving, savedAt, onSave, error }: { section: string; revision: number; saving: boolean; savedAt: number | null; onSave: () => void; error: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", ...muted }}>{section}</span>
      <span style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--color-outline)" }}>r{revision}</span>
      {error && <span style={{ fontSize: 12, color: "#b91c1c" }}>{error}</span>}
      {!error && savedAt && <span style={{ fontSize: 12, color: "var(--color-primary)" }}>Saved</span>}
      <button className="btn-primary text-xs" style={{ marginLeft: "auto" }} disabled={saving} onClick={onSave}><Save size={13} /> {saving ? "Saving…" : "Save"}</button>
    </div>
  );
}
export function Field({ label, onAdd, children }: { label: string; onAdd?: () => void; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", ...muted }}>{label}</span>
        {onAdd && <button className="btn-secondary text-xs" style={{ marginLeft: "auto" }} onClick={onAdd}><Plus size={12} /> Add</button>}
      </div>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </div>
  );
}
export function RemoveBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} title="Remove" style={{ border: "none", background: "none", color: "var(--color-outline)", cursor: "pointer", padding: "0 4px", flex: "none" }}><X size={15} /></button>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 12.5, ...muted }}>{children}</p>;
}

export const muted: CSSProperties = { color: "var(--color-on-surface-variant)" };
export const inputStyle: CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 8, fontSize: 13,
  border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)",
};
export const rowStyle: CSSProperties = { display: "flex", gap: 8, alignItems: "center" };
