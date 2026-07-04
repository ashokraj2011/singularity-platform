"use client";

import Link from "next/link";
import useSWR from "swr";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

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
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const message = responseMessage(parsed, raw, res.statusText);
    const code = typeof obj.code === "string" ? `${obj.code}: ` : "";
    throw new Error(`${res.status} ${code}${message}`);
  }
  assertValidApiResponse(endpoint, raw, parseError);
  return parsed;
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
