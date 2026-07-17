"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { workgraphFetch, WorkgraphError } from "@/lib/workgraph";

/**
 * Generate work items from the project's spec — plan → validate → apply, Terraform-style,
 * so a governed platform never materializes N work items as a side effect of a button click.
 * Compose plan rows (title + target capability + requirement slice), validate (dependency DAG
 * + coverage), then apply → each row becomes one SPEC_GENERATED work item with a specSourceRef.
 * Wires the existing /generation-plans endpoints.
 */
interface EditRow { key: string; title: string; targetCapabilityId: string; requirementIds: string[]; decisionRefs: string[]; estimatedHours: number; estimatedCostHigh?: number; estimatedTokens?: number }
interface PlanRow { id: string; rowKey: string; title: string; state: string; workItemId?: string | null; error?: string | null; projectedStartAt?: string | null; projectedFinishAt?: string | null; criticalPath?: boolean }
interface Plan { id: string; status: string; totalRows: number; appliedRows: number; rows: PlanRow[]; validation?: { valid?: boolean; errors?: string[]; warnings?: string[] } }
interface Cap { id: string; name: string }
interface Req { id: string; statement: string }
interface Decision { id: string; title: string; status: string; claimRefs?: string[] }
interface SpecVersion { id: string; version: number; status: string; contentHash?: string | null }

const emptyRow = (): EditRow => ({ key: crypto.randomUUID().slice(0, 8), title: "", targetCapabilityId: "", requirementIds: [], decisionRefs: [], estimatedHours: 8 });

export function ProjectGeneration({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<EditRow[]>([emptyRow()]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Cap[]>([]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [versions, setVersions] = useState<SpecVersion[]>([]);
  const [specificationVersionId, setSpecificationVersionId] = useState("");

  useEffect(() => {
    let active = true;
    workgraphFetch<{ items?: Array<Record<string, unknown>> }>(`/lookup/capabilities?size=200`)
      .then((r) => { if (active) setCaps((r.items ?? []).map((c) => ({ id: String(c.id ?? c.iamCapabilityId ?? ""), name: String(c.name ?? c.displayName ?? c.label ?? c.id ?? "") })).filter((c) => c.id)); })
      .catch(() => { /* ignore — the picker falls back to a text input */ });
    workgraphFetch<{ package?: { requirements?: Req[] } }>(`/studio/projects/${projectId}/specification`)
      .then((s) => { if (active) setReqs(s.package?.requirements ?? []); })
      .catch(() => { /* ignore */ });
    workgraphFetch<{ items?: Decision[] }>(`/studio/projects/${projectId}/decisions`)
      .then((result) => { if (active) setDecisions((result.items ?? []).filter(item => item.status === "ACCEPTED")); })
      .catch(() => { /* decisions are optional until governed */ });
    workgraphFetch<{ items?: SpecVersion[] }>(`/specifications/${projectId}/versions`)
      .then((result) => {
        if (!active) return;
        const items = result.items ?? [];
        setVersions(items);
        const eligible = items.find(item => ["LOCKED", "ACTIVE", "APPROVED"].includes(item.status));
        setSpecificationVersionId(eligible?.id ?? "");
      })
      .catch(() => { /* compile action on the parent screen can create a version */ });
    return () => { active = false; };
  }, [projectId]);

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
          ...(specificationVersionId ? { specificationVersionId } : {}),
          rows: valid.map((r) => ({
            rowKey: r.key,
            title: r.title.trim(),
            targetCapabilityId: r.targetCapabilityId.trim(),
            requirementIds: r.requirementIds,
            decisionRefs: r.decisionRefs,
            claimRefs: decisions.filter(decision => r.decisionRefs.includes(decision.id)).flatMap(decision => decision.claimRefs ?? []),
            estimatedHours: r.estimatedHours,
            ...(r.estimatedCostHigh !== undefined ? { estimatedCostHigh: r.estimatedCostHigh } : {}),
            ...(r.estimatedTokens !== undefined ? { estimatedTokens: r.estimatedTokens } : {}),
          })),
        }),
      });
      setPlan(created);
    } catch (e) { setError(e instanceof WorkgraphError ? e.message : "Failed to create plan."); } finally { setBusy(null); }
  }, [decisions, projectId, rows, specificationVersionId]);

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
        {plan.validation?.warnings?.length ? <div style={warningBox}>{plan.validation.warnings.map((warning, index) => <div key={index}>• {warning}</div>)}</div> : null}
        {error && <div style={errorBox}>{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {plan.rows.map((r) => (
            <div key={r.id} style={planRowStyle}>
              <span style={rowStateChip(r.state)}>{r.state}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              {r.criticalPath ? <span style={{ fontSize: 9, fontWeight: 800, color: "#b45309" }}>CRITICAL</span> : null}
              {r.projectedFinishAt ? <span style={{ fontSize: 10.5, color: "var(--color-outline)" }}>due {new Date(r.projectedFinishAt).toLocaleDateString()}</span> : null}
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
      <label style={{ display: "grid", gap: 4, maxWidth: 420, fontSize: 11.5, color: "var(--color-outline)" }}>
        Pinned specification version
        <select value={specificationVersionId} onChange={(event) => setSpecificationVersionId(event.target.value)} style={inp}>
          <option value="">No locked version — generation will not create immutable bindings</option>
          {versions.filter(item => ["LOCKED", "ACTIVE", "APPROVED"].includes(item.status)).map(item => <option key={item.id} value={item.id}>v{item.version} · {item.status} · {item.contentHash?.slice(0, 10) ?? "no hash"}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="Work item title" style={{ ...inp, flex: 2 }} />
            {caps.length ? (
              <select value={r.targetCapabilityId} onChange={(e) => setRow(i, { targetCapabilityId: e.target.value })} style={{ ...inp, flex: 1.4 }}>
                <option value="">Target capability…</option>
                {caps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <input value={r.targetCapabilityId} onChange={(e) => setRow(i, { targetCapabilityId: e.target.value })} placeholder="Target capability id" style={{ ...inp, flex: 1.4 }} />
            )}
            <select
              multiple value={r.requirementIds}
              onChange={(e) => setRow(i, { requirementIds: Array.from(e.target.selectedOptions, (o) => o.value) })}
              title="Requirement slice — ⌘/ctrl-click to select multiple"
              style={{ ...inp, flex: 1.8, height: 60, padding: "4px 6px" }}
            >
              {reqs.length === 0 && <option disabled>No requirements in the spec yet</option>}
              {reqs.map((rq) => <option key={rq.id} value={rq.id}>{rq.id} · {rq.statement.slice(0, 44)}</option>)}
            </select>
            <select
              multiple value={r.decisionRefs}
              onChange={(e) => setRow(i, { decisionRefs: Array.from(e.target.selectedOptions, option => option.value) })}
              title="Accepted decisions carried into this WorkItem"
              style={{ ...inp, flex: 1.4, height: 60, padding: "4px 6px" }}
            >
              {decisions.length === 0 && <option disabled>No accepted decisions</option>}
              {decisions.map(decision => <option key={decision.id} value={decision.id}>{decision.title}</option>)}
            </select>
            <input type="number" min={0.5} step={0.5} value={r.estimatedHours} onChange={(e) => setRow(i, { estimatedHours: Math.max(0.5, Number(e.target.value) || 0.5) })} title="Estimated effort in hours" style={{ ...inp, width: 72 }} />
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
const warningBox: CSSProperties = { fontSize: 11.5, color: "#92400e", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "8px 11px", lineHeight: 1.5 };
