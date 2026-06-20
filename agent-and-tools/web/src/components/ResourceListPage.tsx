"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ArrowLeft, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { apiPath, authHeaders, identityApi, saveAgentToolsToken } from "@/lib/api";

type Column = {
  label: string;
  key: string;
  fallback?: string;
};

type ResourceListPageProps = {
  title: string;
  description: string;
  endpoint: string;
  backHref: string;
  backLabel: string;
  columns: Column[];
  itemKeys?: string[];
  detailHref?: string;
  emptyLabel?: string;
  refreshInterval?: number;
};

function getPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, row);
}

function unwrapItems(data: unknown, keys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(Boolean) as Record<string, unknown>[];
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of [...keys, "items", "data", "content", "runs", "templates", "workItems", "repos", "changePlans", "tasks", "gaps", "artifacts"]) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  return [];
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["name", "title", "label", "id", "key", "status"]) {
      if (typeof obj[key] === "string" || typeof obj[key] === "number") return String(obj[key]);
    }
  }
  return JSON.stringify(value).slice(0, 160);
}

function formatMaybeDate(value: unknown): string {
  if (typeof value !== "string") return valueText(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function hrefFor(template: string, row: Record<string, unknown>): string | null {
  let missingRequiredValue = false;
  const href = template.replace(/:([a-zA-Z0-9_.-]+)/g, (_, key: string) => {
    const directValue = getPath(row, key);
    const fallbackValue = ["id", "uid", "runId"].includes(key) ? row.id ?? row.uid ?? row.runId : undefined;
    const value = directValue ?? fallbackValue;
    if (value === null || value === undefined || value === "") {
      missingRequiredValue = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  return missingRequiredValue ? null : href;
}

async function fetchResource(endpoint: string): Promise<unknown> {
  const res = await fetch(apiPath(endpoint), {
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const obj = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const message = obj.message ?? obj.error ?? text ?? res.statusText;
    const code = typeof obj.code === "string" ? `${obj.code}: ` : "";
    throw new Error(`${res.status} ${code}${message}`);
  }
  return body;
}

export function ResourceListPage({
  title,
  description,
  endpoint,
  backHref,
  backLabel,
  columns,
  itemKeys = [],
  detailHref,
  emptyLabel = "No records found.",
  refreshInterval = 10000,
}: ResourceListPageProps) {
  const { data, error, isLoading, mutate } = useSWR(endpoint, fetchResource, { refreshInterval });
  const items = unwrapItems(data, itemKeys);
  const isUnauthorized = error instanceof Error && /^401\b/.test(error.message);
  const isFeatureDisabled = error instanceof Error && /FEATURE_DISABLED|feature .*disabled|feature '.*' is OFF/i.test(error.message);

  return (
    <div style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <Link href={backHref} className="btn-secondary">
          <ArrowLeft size={15} />
          {backLabel}
        </Link>
        <button type="button" className="btn-secondary" onClick={() => mutate()}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <section className="card" style={{ padding: 22, marginBottom: 18 }}>
        <h1 className="page-header" style={{ marginBottom: 8 }}>{title}</h1>
        <p style={{ maxWidth: 760, color: "var(--color-outline)", lineHeight: 1.6, fontSize: 14, margin: 0 }}>
          {description}
        </p>
      </section>

      {isUnauthorized && <InlineSignInPanel onAuthenticated={() => void mutate()} />}

      {isFeatureDisabled && (
        <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(217,119,6,0.28)", background: "rgba(255,251,235,0.82)" }}>
          <div style={{ fontWeight: 800, color: "#92400e", marginBottom: 4 }}>Feature disabled</div>
          <div style={{ color: "#78350f", fontSize: 13 }}>
            This surface is wired, but the backend feature flag is currently off. Enable the feature flag from Operations when you want this data plane active.
          </div>
        </section>
      )}

      {error && !isUnauthorized && !isFeatureDisabled && (
        <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.8)" }}>
          <div style={{ fontWeight: 800, color: "#991b1b", marginBottom: 4 }}>Could not load this surface.</div>
          <div style={{ color: "#7f1d1d", fontSize: 13 }}>{(error as Error).message}</div>
        </section>
      )}

      {!isFeatureDisabled && <section className="card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {columns.map((column) => (
                  <th key={column.key} className="text-left px-4 py-3 font-medium text-slate-600">{column.label}</th>
                ))}
                {detailHref && <th className="text-left px-4 py-3 font-medium text-slate-600">Open</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((row, index) => {
                const rowHref = detailHref ? hrefFor(detailHref, row) : null;
                return (
                  <tr key={String(row.id ?? row.uid ?? row.key ?? index)} className="hover:bg-slate-50">
                    {columns.map((column) => {
                      const value = getPath(row, column.key) ?? (column.fallback ? getPath(row, column.fallback) : undefined);
                      return (
                        <td key={column.key} className="px-4 py-3 text-slate-700">
                          <span title={valueText(value)}>{formatMaybeDate(value)}</span>
                        </td>
                      );
                    })}
                    {detailHref && (
                      <td className="px-4 py-3">
                        {rowHref ? (
                          <Link href={rowHref} className="btn-secondary text-xs">
                            <ExternalLink size={13} />
                            Open
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">No run</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {!isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (detailHref ? 1 : 0)} className="px-4 py-12 text-center text-slate-400">
                    {emptyLabel}
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td colSpan={columns.length + (detailHref ? 1 : 0)} className="px-4 py-12 text-center text-slate-400">
                    Loading...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>}
    </div>
  );
}

function InlineSignInPanel({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState("admin@singularity.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await identityApi.login({ email, password });
      saveAgentToolsToken(res.access_token, res.user);
      onAuthenticated();
    } catch (err) {
      setError((err as Error).message || "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ padding: 18, marginBottom: 18, borderColor: "rgba(0,132,61,0.24)", background: "rgba(240,253,244,0.75)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, marginBottom: 6 }}>
        <ShieldCheck size={16} color="var(--color-primary)" />
        Sign in to load this surface
      </div>
      <p style={{ margin: "0 0 12px", color: "var(--color-outline)", fontSize: 13 }}>
        Workflows, workbench, identity, and governance APIs require an IAM bearer. Use the bootstrap IAM credentials from your local Singularity config.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, alignItems: "center" }}>
        <input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="email"
          autoComplete="username"
          style={{ minWidth: 0, border: "1px solid var(--color-outline-variant)", borderRadius: 10, padding: "9px 11px", fontSize: 13 }}
        />
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          type="password"
          autoComplete="current-password"
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          style={{ minWidth: 0, border: "1px solid var(--color-outline-variant)", borderRadius: 10, padding: "9px 11px", fontSize: 13 }}
        />
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || !email || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </div>
      {error && <div style={{ marginTop: 10, color: "#991b1b", fontSize: 12 }}>{error}</div>}
    </section>
  );
}
