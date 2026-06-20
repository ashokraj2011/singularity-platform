"use client";

import { apiPath, authHeaders } from "@/lib/api";

export class WorkgraphError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "WorkgraphError";
  }
}

export function unwrapWorkgraphItems<T = Record<string, unknown>>(data: unknown, extraKeys: string[] = []): T[] {
  if (Array.isArray(data)) return data as T[];
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of [...extraKeys, "items", "content", "data", "runs", "templates", "instances", "workItems", "nodes", "edges", "artifacts"]) {
    if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  return [];
}

export async function workgraphFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(`/api/workgraph${path.startsWith("/") ? path : `/${path}`}`), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
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
    const code = typeof obj.code === "string" ? obj.code : undefined;
    const message = String(obj.message ?? obj.error ?? text ?? res.statusText);
    throw new WorkgraphError(message, res.status, code);
  }
  return body as T;
}

export function shortId(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text || "-";
}

export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["name", "title", "label", "id", "key", "status"]) {
      if (typeof obj[key] === "string" || typeof obj[key] === "number") return String(obj[key]);
    }
  }
  return JSON.stringify(value).slice(0, 180);
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return valueText(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
