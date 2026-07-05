"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createGitConnection,
  deleteGitConnection,
  listGitConnections,
  updateGitConnection,
  type GitConnection,
} from "@/lib/git/api";
import { Chip, FormError, GitField, GitTextarea, PageShell, SubmitButton, TwoColumn } from "@/components/git/formKit";

const emptyForm = {
  tenantId: "",
  provider: "github_app",
  appId: "",
  installationId: "",
  accountLogin: "",
  privateKey: "",
};

export function GitConnectionsConsole() {
  const [rows, setRows] = useState<GitConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [editing, setEditing] = useState<GitConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await listGitConnections());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const canSubmit = editing
    ? Boolean(form.appId.trim() && form.installationId.trim())
    : Boolean(form.tenantId.trim() && form.appId.trim() && form.installationId.trim() && form.privateKey.trim());

  function startEdit(connection: GitConnection) {
    setEditing(connection);
    setSubmitError(null);
    setForm({
      tenantId: connection.tenantId,
      provider: connection.provider || "github_app",
      appId: connection.appId,
      installationId: connection.installationId,
      accountLogin: connection.accountLogin ?? "",
      privateKey: "",
    });
  }

  function resetForm() {
    setEditing(null);
    setForm({ ...emptyForm });
    setSubmitError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      if (editing) {
        await updateGitConnection(editing.id, {
          provider: form.provider.trim() || "github_app",
          appId: form.appId.trim(),
          installationId: form.installationId.trim(),
          accountLogin: form.accountLogin.trim(),
          ...(form.privateKey.trim() ? { privateKey: form.privateKey } : {}),
        });
      } else {
        await createGitConnection({
          tenantId: form.tenantId.trim(),
          provider: form.provider.trim() || "github_app",
          appId: form.appId.trim(),
          installationId: form.installationId.trim(),
          accountLogin: form.accountLogin.trim() || undefined,
          privateKey: form.privateKey,
        });
      }
      resetForm();
      await reload();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(connection: GitConnection, status: "active" | "suspended" | "revoked") {
    setActionBusyId(connection.id);
    setSubmitError(null);
    try {
      await updateGitConnection(connection.id, { status });
      await reload();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyId(null);
    }
  }

  async function remove(connection: GitConnection) {
    if (!window.confirm(`Delete GitHub connection "${connection.accountLogin || connection.appId}"? Existing credential issuance audit stays recorded, but this app installation will no longer be usable.`)) return;
    setActionBusyId(connection.id);
    setSubmitError(null);
    try {
      await deleteGitConnection(connection.id);
      await reload();
      if (editing?.id === connection.id) resetForm();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <PageShell
      title="GitHub Connections"
      description="Per-tenant GitHub App installations the credential broker uses to mint short-lived, repo-scoped push tokens. The private key is write-only — it is never returned by the API."
    >
      <TwoColumn>
        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>
            Connections {rows.length ? `(${rows.length})` : ""}
          </h2>
          <FormError message={submitError} />
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--color-outline)" }}>Loading…</p>
          ) : loadError ? (
            <FormError message={loadError} />
          ) : rows.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--color-outline)" }}>
              No GitHub App connections yet. Add one for a tenant to enable brokered git pushes.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map((c) => (
                <div
                  key={c.id}
                  style={{
                    border: "1px solid var(--color-outline-variant)",
                    borderRadius: 10,
                    padding: 12,
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13, color: "var(--color-text)" }}>{c.accountLogin || c.appId}</strong>
                    <Chip tone={c.status === "active" ? "good" : "neutral"}>{c.status}</Chip>
                  </div>
                  <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", margin: 0, fontSize: 12 }}>
                    <Meta label="Tenant" value={c.tenantId} />
                    <Meta label="Provider" value={c.provider} />
                    <Meta label="App ID" value={c.appId} />
                    <Meta label="Installation" value={c.installationId} />
                  </dl>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    <button className="btn-secondary text-xs" type="button" disabled={actionBusyId === c.id} onClick={() => startEdit(c)}>Edit / rotate</button>
                    {c.status === "active" ? (
                      <button className="btn-secondary text-xs" type="button" disabled={actionBusyId === c.id} onClick={() => void setStatus(c, "suspended")}>Suspend</button>
                    ) : (
                      <button className="btn-secondary text-xs" type="button" disabled={actionBusyId === c.id} onClick={() => void setStatus(c, "active")}>Activate</button>
                    )}
                    <button className="btn-secondary text-xs" type="button" disabled={actionBusyId === c.id} onClick={() => void setStatus(c, "revoked")}>Revoke</button>
                    <button className="btn-secondary text-xs" type="button" disabled={actionBusyId === c.id} style={{ color: "#b91c1c" }} onClick={() => void remove(c)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>{editing ? "Edit connection" : "Add connection"}</h2>
            {editing ? <button type="button" className="btn-secondary text-xs" onClick={resetForm}>Cancel edit</button> : null}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            <GitField label="Tenant ID" value={form.tenantId} onChange={(v) => setForm({ ...form, tenantId: v })} placeholder="tenant uuid" disabled={Boolean(editing)} />
            <GitField label="Provider" value={form.provider} onChange={(v) => setForm({ ...form, provider: v })} placeholder="github_app" />
            <GitField label="GitHub App ID" value={form.appId} onChange={(v) => setForm({ ...form, appId: v })} placeholder="123456" />
            <GitField label="Installation ID" value={form.installationId} onChange={(v) => setForm({ ...form, installationId: v })} placeholder="987654" />
            <GitField label="Account login (optional)" value={form.accountLogin} onChange={(v) => setForm({ ...form, accountLogin: v })} placeholder="my-org" />
            <GitTextarea
              label={editing ? "Rotate private key (optional)" : "App private key (PEM)"}
              value={form.privateKey}
              onChange={(v) => setForm({ ...form, privateKey: v })}
              placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
            />
            <p style={{ margin: 0, fontSize: 11, color: "var(--color-outline)" }}>
              Stored server-side and never returned. Leave blank while editing to keep the current key.
            </p>
            <SubmitButton busy={busy} disabled={!canSubmit} idleLabel={editing ? "Save connection" : "Create connection"} busyLabel="Saving…" onClick={() => void submit()} />
          </div>
        </section>
      </TwoColumn>
    </PageShell>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: "var(--color-outline)", fontWeight: 700 }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--color-text)", wordBreak: "break-all" }}>{value}</dd>
    </>
  );
}
