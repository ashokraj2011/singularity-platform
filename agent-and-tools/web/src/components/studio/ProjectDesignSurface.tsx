"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Plus, X } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { patchSection, specKey, type Decision, type DecisionStatus, type ProjectSpec } from "./projectSpec";
import { SaveBar, Field, Empty, muted, inputStyle } from "./ProjectAnalysisSurface";

/**
 * Project-level Design — the architecture decisions (ADRs) the whole project builds against.
 * Recorded once at the project so every work item inherits the same design intent. Saves the
 * `decisions` section with the loaded revision (409 on a stale edit).
 */
const STATUSES: DecisionStatus[] = ["PROPOSED", "ACCEPTED", "SUPERSEDED", "REJECTED"];
const statusColor: Record<DecisionStatus, string> = {
  PROPOSED: "var(--color-on-surface-variant)",
  ACCEPTED: "#3ecf8e",
  SUPERSEDED: "#f5b544",
  REJECTED: "#f2688a",
};

export function ProjectDesignSurface({ projectId }: { projectId: string }) {
  const { data: spec, error, isLoading, mutate } = useSWR<ProjectSpec>(specKey(projectId), (url: string) => workgraphFetch<ProjectSpec>(url));
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (spec) setDecisions(spec.package.decisions ?? []);
  }, [spec?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  function nextId(): string {
    const nums = decisions.map((d) => Number(/^ADR-(\d+)$/.exec(d.id)?.[1] ?? 0));
    return `ADR-${Math.max(0, ...nums) + 1}`;
  }
  function update(i: number, next: Partial<Decision>) {
    setDecisions((arr) => arr.map((d, j) => (j === i ? { ...d, ...next } : d)));
  }

  async function save() {
    if (!spec) return;
    setSaving(true); setSaveError(null);
    const cleaned = decisions
      .filter((d) => d.title.trim())
      .map((d) => ({
        id: d.id, title: d.title.trim(), status: d.status, decision: d.decision.trim(),
        ...(d.context?.trim() ? { context: d.context.trim() } : {}),
        ...(d.consequences?.trim() ? { consequences: d.consequences.trim() } : {}),
      }));
    try {
      await mutate(patchSection(projectId, "decisions", cleaned, spec.revision), { revalidate: false });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save. Reload and try again.");
      mutate();
    } finally { setSaving(false); }
  }

  if (isLoading) return <p style={muted}>Loading…</p>;
  if (error || !spec) return <div className="card" style={{ padding: 16, ...muted }}>Couldn&apos;t load the project design. <button className="btn-secondary text-xs" onClick={() => mutate()} style={{ marginLeft: 8 }}>Retry</button></div>;

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 860 }}>
      <SaveBar section="Design · Decisions" revision={spec.revision} saving={saving} savedAt={savedAt} onSave={save} error={saveError} />

      <Field label="Architecture decisions" onAdd={() => setDecisions((d) => [...d, { id: nextId(), title: "", status: "PROPOSED", decision: "" }])}>
        {decisions.length === 0 && <Empty>No decisions recorded yet. Capture the choices the whole project builds on.</Empty>}
        {decisions.map((d, i) => (
          <div key={i} className="card" style={{ padding: 14, display: "grid", gap: 9 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="badge badge-draft" style={{ fontFamily: "var(--font-mono, monospace)" }}>{d.id}</span>
              <input value={d.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Decision title" style={{ ...inputStyle, flex: 1, fontWeight: 600 }} />
              <select value={d.status} onChange={(e) => update(i, { status: e.target.value as DecisionStatus })}
                style={{ ...inputStyle, width: 140, fontWeight: 700, color: statusColor[d.status] }}>
                {STATUSES.map((s) => <option key={s} value={s} style={{ color: "var(--color-on-surface)" }}>{s.toLowerCase()}</option>)}
              </select>
              <button onClick={() => setDecisions((arr) => arr.filter((_, j) => j !== i))} title="Remove" style={{ border: "none", background: "none", color: "var(--color-outline)", cursor: "pointer", flex: "none" }}><X size={16} /></button>
            </div>
            <textarea value={d.context ?? ""} onChange={(e) => update(i, { context: e.target.value })} placeholder="Context — what forces are at play?" style={{ ...inputStyle, minHeight: 48, resize: "vertical" }} />
            <textarea value={d.decision} onChange={(e) => update(i, { decision: e.target.value })} placeholder="Decision — what we chose" style={{ ...inputStyle, minHeight: 48, resize: "vertical" }} />
            <textarea value={d.consequences ?? ""} onChange={(e) => update(i, { consequences: e.target.value })} placeholder="Consequences — what this makes easy or hard" style={{ ...inputStyle, minHeight: 40, resize: "vertical" }} />
          </div>
        ))}
      </Field>
      <button className="btn-secondary text-xs" style={{ justifySelf: "start" }} onClick={() => setDecisions((d) => [...d, { id: nextId(), title: "", status: "PROPOSED", decision: "" }])}><Plus size={13} /> Add decision</button>
    </div>
  );
}
