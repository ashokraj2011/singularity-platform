"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createGitConnection,
  listGitConnections,
  type GitConnection,
} from "@/lib/git/api";
import { Chip, FormError, GitField, GitTextarea, PageShell, SubmitButton, TwoColumn } from "@/components/git/formKit";

const emptyForm = {
  tenantId: "",
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
  const [busy, setBusy] = useState(false);
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

  const canSubmit = Boolean(form.tenantId.trim() && form.appId.trim() && form.installationId.trim() && form.privateKey.trim());

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await createGitConnection({
        tenantId: form.tenantId.trim(),
        appId: form.appId.trim(),
        installationId: form.installationId.trim(),
        accountLogin: form.accountLogin.trim() || undefined,
        privateKey: form.privateKey,
      });
      setForm({ ...emptyForm });
      await reload();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 800, color: "var(--color-text)" }}>Add connection</h2>
          <div style={{ display: "grid", gap: 10 }}>
            <GitField label="Tenant ID" value={form.tenantId} onChange={(v) => setForm({ ...form, tenantId: v })} placeholder="tenant uuid" />
            <GitField label="GitHub App ID" value={form.appId} onChange={(v) => setForm({ ...form, appId: v })} placeholder="123456" />
            <GitField label="Installation ID" value={form.installationId} onChange={(v) => setForm({ ...form, installationId: v })} placeholder="987654" />
            <GitField label="Account login (optional)" value={form.accountLogin} onChange={(v) => setForm({ ...form, accountLogin: v })} placeholder="my-org" />
            <GitTextarea
              label="App private key (PEM)"
              value={form.privateKey}
              onChange={(v) => setForm({ ...form, privateKey: v })}
              placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
            />
            <p style={{ margin: 0, fontSize: 11, color: "var(--color-outline)" }}>
              Stored server-side and never returned. Plaintext-v0 storage is gated off in production until KMS/Vault.
            </p>
            <FormError message={submitError} />
            <SubmitButton busy={busy} disabled={!canSubmit} idleLabel="Create connection" busyLabel="Creating…" onClick={() => void submit()} />
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
