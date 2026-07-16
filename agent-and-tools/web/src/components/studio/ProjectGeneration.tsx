"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";

/**
 * Generate work items from the project's spec — plan → validate → apply, Terraform-style,
 * so a governed platform never materializes N work items as a side effect of a button click.
 * Compose plan rows (title + target capability + requirement slice), validate (dependency DAG
 * + coverage), then apply → each row becomes one SPEC_GENERATED work item with a specSourceRef.
 * Wires the existing /generation-plans endpoints.
 */
interface EditRow { key: string; title: string; targetCapabilityId: string; requirementIds: string }
interface PlanRow { id: string; rowKey: string; title: string; state: string; workItemId?: string | null; error?: string | null }
interface Plan { id: string; status: string; totalRows: number; appliedRows: number; rows: PlanRow[]; validation?: { valid?: boolean; errors?: string[] } }

const splitCsv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
const emptyRow = (): EditRow => ({ key: crypto.randomUUID().slice(0, 8), title: "", targetCapabilityId: "", requirementIds: "" });

export function ProjectGeneration({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<EditRow[]>([emptyRow()]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const createPlan = useCallback(async () => {
    const valid = rows.filter((r) => r.title.trim() && r.targetCapabilityId.trim());
    if (!valid.length) { setError("Add at least one row with a title and a target capability."); return; }
    setBusy("create"); setError(null);
    try {
      const created = await workgraphFetch<Plan>(`/generation-plans`, {
        method: "POST",
        body: JSON.stringify({
          specificationProjectId: projectId,
          rows: valid.map((r) => ({ rowKey: r.key, title: r.title.trim(), targetCapabilityId: r.targetCapabilityId.trim(), requirementIds: splitCsv(r.requirementIds) })),
        }),
      });
      setPlan(created);
    } catch (e) { setError(e instanceof WorkgraphError ? e.message : "Failed to create plan."); } finally { setBusy(null); }
  }, [rows, projectId]);

  const validate = useCallback(async () => {
    if (!plan) return;
    setBusy("validate"); setError(null);
    try {
      setPlan(await workgraphFetch<Plan>(`/generation-plans/${plan.id}/validate`, { method: "POST" }));
    } catch (e) { setError(e instanceof WorkgraphError ? e.message : "Validation failed — check dependencies and rows."); } finally { setBusy(null); }
  }, [plan]);

  const apply = useCallback(async () => {
    if (!plan) return;
    setBusy("apply"); setError(null);
    try {
      setPlan(await workgraphFetch<Plan>(`/generation-plans/${plan.id}/apply`, { method: "POST" }));
    } catch (e) { setError(e instanceof WorkgraphError ? e.message : "Apply failed."); } finally { setBusy(null); }
  }, [plan]);

  const reset = () => { setPlan(null); setRows([emptyRow()]); setError(null); };

  if (plan) {
    const validated = plan.status === "VALIDATED" || plan.validation?.valid === true;
    const applied = plan.appliedRows > 0 || plan.status === "APPLIED";
    return (
      <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 13 }}>Generation plan</b>
          <span style={statusChip}>{plan.status}</span>
          <span style={{ fontSize: 11.5, color: "var(--color-outline)" }}>{plan.appliedRows}/{plan.totalRows} applied</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => void validate()} disabled={!!busy} style={btn(false)}>{busy === "validate" ? "Validating…" : "Validate"}</button>
            <button onClick={() => void apply()} disabled={!!busy || !validated || applied} style={primaryBtn(!validated || applied)}>{busy === "apply" ? "Applying…" : "Apply → generate"}</button>
            <button onClick={reset} style={btn(false)}>New plan</button>
          </div>
        </div>
        {plan.validation?.errors?.length ? (
          <div style={errorBox}>{plan.validation.errors.map((er, i) => <div key={i}>• {er}</div>)}</div>
        ) : validated && !applied ? (
          <div style={okBox}>Validated — coverage and dependency DAG are clean. Apply to generate the work items.</div>
        ) : null}
        {error && <div style={errorBox}>{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {plan.rows.map((r) => (
            <div key={r.id} style={planRowStyle}>
              <span style={rowStateChip(r.state)}>{r.state}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              {r.workItemId && <a href={`/work-items/${r.workItemId}`} style={{ fontSize: 11.5, color: "var(--color-primary, #6366f1)", textDecoration: "none" }}>open →</a>}
              {r.error && <span style={{ fontSize: 11, color: "#dc2626", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.error}</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <b style={{ fontSize: 13 }}>Generate work items</b>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--color-outline)", lineHeight: 1.5 }}>
          Compose the decomposition: one row per work item, each with a target capability and its requirement slice. Nothing is created until you review and apply — plan → validate → apply.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="Work item title" style={{ ...inp, flex: 2 }} />
            <input value={r.targetCapabilityId} onChange={(e) => setRow(i, { targetCapabilityId: e.target.value })} placeholder="Target capability id" style={{ ...inp, flex: 1.4 }} />
            <input value={r.requirementIds} onChange={(e) => setRow(i, { requirementIds: e.target.value })} placeholder="requirement ids (comma-sep)" style={{ ...inp, flex: 1.6 }} />
            <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1} title="Remove" style={{ ...btn(rows.length === 1), padding: "4px 9px" }}>×</button>
          </div>
        ))}
      </div>
      {error && <div style={errorBox}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setRows((rs) => [...rs, emptyRow()])} style={btn(false)}>+ Row</button>
        <button onClick={() => void createPlan()} disabled={!!busy} style={primaryBtn(false)}>{busy === "create" ? "Creating…" : "Create plan"}</button>
      </div>
    </div>
  );
}

const inp: CSSProperties = { fontSize: 12.5, padding: "6px 10px", borderRadius: 7, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)", minWidth: 0 };
function btn(disabled: boolean): CSSProperties {
  return { fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 7, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)", color: "var(--color-on-surface)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 };
}
function primaryBtn(disabled: boolean): CSSProperties {
  return { fontSize: 12, fontWeight: 650, padding: "6px 13px", borderRadius: 7, border: "none", background: "var(--color-primary, #6366f1)", color: "#fff", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 };
}
const statusChip: CSSProperties = { fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-outline)", letterSpacing: "0.04em" };
const planRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderRadius: 8, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface)" };
function rowStateChip(state: string): CSSProperties {
  const c = state === "APPLIED" ? "#16a34a" : state === "FAILED" ? "#dc2626" : "#6366f1";
  return { fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: `${c}22`, color: c, flexShrink: 0, letterSpacing: "0.04em" };
}
const errorBox: CSSProperties = { fontSize: 11.5, color: "#991b1b", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.3)", borderRadius: 8, padding: "8px 11px", lineHeight: 1.5 };
const okBox: CSSProperties = { fontSize: 11.5, color: "#166534", background: "rgba(22,163,74,0.08)", border: "1px solid rgba(22,163,74,0.3)", borderRadius: 8, padding: "8px 11px" };
