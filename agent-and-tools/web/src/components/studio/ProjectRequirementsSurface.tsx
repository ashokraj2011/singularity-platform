"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Plus, X } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { patchSection, specKey, type Requirement, type RequirementPriority, type ProjectSpec } from "./projectSpec";
import { SaveBar, Field, Empty, muted, inputStyle } from "./ProjectAnalysisSurface";

/**
 * Project-level Requirements — the shared, numbered requirements the whole project commits to, with
 * priority and acceptance criteria. Authored once at the project; work items draw on them. Saves the
 * `requirements` section with the loaded revision (409 on a stale edit).
 */
const PRIORITIES: RequirementPriority[] = ["MUST", "SHOULD", "MAY"];
const priorityColor: Record<RequirementPriority, string> = {
  MUST: "#b91c1c",
  SHOULD: "#b45309",
  MAY: "var(--color-on-surface-variant)",
};

export function ProjectRequirementsSurface({ projectId }: { projectId: string }) {
  const { data: spec, error, isLoading, mutate } = useSWR<ProjectSpec>(specKey(projectId), (url: string) => workgraphFetch<ProjectSpec>(url));
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [acText, setAcText] = useState<Record<string, string>>({}); // id → acceptance criteria textarea
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!spec) return;
    const rs = spec.package.requirements ?? [];
    setReqs(rs);
    setAcText(Object.fromEntries(rs.map((r) => [r.id, (r.acceptanceCriteria ?? []).join("\n")])));
  }, [spec?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  function nextId(): string {
    const nums = reqs.map((r) => Number(/^REQ-(\d+)$/.exec(r.id)?.[1] ?? 0));
    return `REQ-${Math.max(0, ...nums) + 1}`;
  }
  function update(i: number, next: Partial<Requirement>) {
    setReqs((arr) => arr.map((r, j) => (j === i ? { ...r, ...next } : r)));
  }
  function addReq() {
    const id = nextId();
    setReqs((arr) => [...arr, { id, statement: "", priority: "SHOULD", acceptanceCriteria: [] }]);
    setAcText((m) => ({ ...m, [id]: "" }));
  }

  async function save() {
    if (!spec) return;
    setSaving(true); setSaveError(null);
    const cleaned = reqs
      .filter((r) => r.statement.trim())
      .map((r) => ({
        id: r.id,
        statement: r.statement.trim(),
        priority: r.priority,
        acceptanceCriteria: (acText[r.id] ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        ...(r.rationale?.trim() ? { rationale: r.rationale.trim() } : {}),
      }));
    try {
      await mutate(patchSection(projectId, "requirements", cleaned, spec.revision), { revalidate: false });
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save. Reload and try again.");
      mutate();
    } finally { setSaving(false); }
  }

  if (isLoading) return <p style={muted}>Loading…</p>;
  if (error || !spec) return <div className="card" style={{ padding: 16, ...muted }}>Couldn&apos;t load the project requirements. <button className="btn-secondary text-xs" onClick={() => mutate()} style={{ marginLeft: 8 }}>Retry</button></div>;

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 860 }}>
      <SaveBar section="Requirements" revision={spec.revision} saving={saving} savedAt={savedAt} onSave={save} error={saveError} />

      <Field label="Requirements" onAdd={addReq}>
        {reqs.length === 0 && <Empty>No requirements yet. Capture what the project must deliver, once, for every work item to build against.</Empty>}
        {reqs.map((r, i) => (
          <div key={i} className="card" style={{ padding: 14, display: "grid", gap: 9 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="badge badge-draft" style={{ fontFamily: "var(--font-mono, monospace)" }}>{r.id}</span>
              <select value={r.priority} onChange={(e) => update(i, { priority: e.target.value as RequirementPriority })}
                style={{ ...inputStyle, width: 120, fontWeight: 700, color: priorityColor[r.priority] }}>
                {PRIORITIES.map((p) => <option key={p} value={p} style={{ color: "var(--color-on-surface)" }}>{p}</option>)}
              </select>
              <button onClick={() => setReqs((arr) => arr.filter((_, j) => j !== i))} title="Remove" style={{ marginLeft: "auto", border: "none", background: "none", color: "var(--color-outline)", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <textarea value={r.statement} onChange={(e) => update(i, { statement: e.target.value })} placeholder="The requirement — e.g. A refund MUST settle within 3 business days." style={{ ...inputStyle, minHeight: 46, resize: "vertical" }} />
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", ...muted, marginBottom: 5 }}>Acceptance criteria <span style={{ fontWeight: 400 }}>· one per line</span></div>
              <textarea value={acText[r.id] ?? ""} onChange={(e) => setAcText((m) => ({ ...m, [r.id]: e.target.value }))} placeholder="Given… when… then…" style={{ ...inputStyle, minHeight: 54, resize: "vertical", fontFamily: "var(--font-mono, monospace)", fontSize: 12 }} />
            </div>
          </div>
        ))}
      </Field>
      <button className="btn-secondary text-xs" style={{ justifySelf: "start" }} onClick={addReq}><Plus size={13} /> Add requirement</button>
    </div>
  );
}
