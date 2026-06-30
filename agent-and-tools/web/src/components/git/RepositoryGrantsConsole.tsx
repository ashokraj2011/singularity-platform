"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createRepositoryGrant,
  listRepositoryGrants,
  type GitSubjectType,
  type RepositoryGrant,
} from "@/lib/git/api";
import {
  Chip,
  FormError,
  GitCheckboxGroup,
  GitField,
  GitSelect,
  PageShell,
  SubmitButton,
  TwoColumn,
} from "@/components/git/formKit";

// v1 broker operations. read/clone/push are the active git-workspace ops;
// pr/comment are deferred (no MCP tool path yet) so they're intentionally omitted
// here to avoid granting permissions nothing enforces.
const OPERATION_OPTIONS = [
  { value: "read", label: "Read (discovery / fetch)" },
  { value: "clone", label: "Clone" },
  { value: "push", label: "Push" },
];

const SUBJECT_OPTIONS: { value: GitSubjectType; label: string }[] = [
  { value: "user", label: "User" },
  { value: "team", label: "Team" },
  { value: "capability", label: "Capability" },
];

const emptyForm = {
  tenantId: "",
  subjectType: "user" as GitSubjectType,
  subjectId: "",
  repo: "",
};

export function RepositoryGrantsConsole() {
  const [rows, setRows] = useState<RepositoryGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [operations, setOperations] = useState<Set<string>>(new Set(["read", "clone", "push"]));
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await listRepositoryGrants());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function toggleOperation(op: string) {
    setOperations((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
  }

  const canSubmit = Boolean(form.tenantId.trim() && form.subjectId.trim() && form.repo.trim() && operations.size > 0);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await createRepositoryGrant({
        tenantId: form.tenantId.trim(),
        subjectType: form.subjectType,
        subjectId: form.subjectId.trim(),
        repo: form.repo.trim(),
        operations: Array.from(operations),
      });
      setForm({ ...emptyForm });
      setOperations(new Set(["read", "clone", "push"]));
      await reload();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title="Repository Grants"
      description="Authorize which user, team, or capability may run which git operations on which repository. The broker only issues a credential when a matching grant exists for the requesting identity, repo, and operation."
    >
      <TwoColumn>
        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>
            Grants {rows.length ? `(${rows.length})` : ""}
          </h2>
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--color-outline)" }}>Loading…</p>
          ) : loadError ? (
            <FormError message={loadError} />
          ) : rows.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--color-outline)" }}>
              No repository grants yet. Add one to let a subject push to a repo through the broker.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((g) => (
                <div
                  key={g.id}
                  style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13, color: "var(--color-text)", wordBreak: "break-all" }}>{g.repo}</strong>
                    <Chip tone={g.status === "active" ? "good" : "neutral"}>{g.status}</Chip>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--color-outline)" }}>
                    <span style={{ fontWeight: 700 }}>{g.subjectType}</span>
                    <span style={{ color: "var(--color-text)" }}> {g.subjectId}</span>
                    <span> · tenant {g.tenantId}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {g.operations.map((op) => (
                      <Chip key={op}>{op}</Chip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>Add grant</h2>
          <div style={{ display: "grid", gap: 10 }}>
            <GitField label="Tenant ID" value={form.tenantId} onChange={(v) => setForm({ ...form, tenantId: v })} placeholder="tenant uuid" />
            <GitSelect
              label="Subject type"
              value={form.subjectType}
              options={SUBJECT_OPTIONS}
              onChange={(v) => setForm({ ...form, subjectType: v })}
            />
            <GitField
              label="Subject ID"
              value={form.subjectId}
              onChange={(v) => setForm({ ...form, subjectId: v })}
              placeholder={form.subjectType === "user" ? "user uuid" : form.subjectType === "team" ? "team id" : "capability id"}
            />
            <GitField label="Repository" value={form.repo} onChange={(v) => setForm({ ...form, repo: v })} placeholder="owner/name" />
            <GitCheckboxGroup label="Operations" options={OPERATION_OPTIONS} selected={operations} onToggle={toggleOperation} />
            <FormError message={submitError} />
            <SubmitButton busy={busy} disabled={!canSubmit} idleLabel="Create grant" busyLabel="Creating…" onClick={() => void submit()} />
          </div>
        </section>
      </TwoColumn>
    </PageShell>
  );
}
