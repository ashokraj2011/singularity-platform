"use client";

import { apiPath, authHeaders, invalidApiResponseMessage, readResponseBody, responseMessage } from "@/lib/api";

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
  let res: Response;
  const url = `/api/workgraph${path.startsWith("/") ? path : `/${path}`}`;
  try {
    res = await fetch(apiPath(url), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new WorkgraphError(err instanceof Error ? err.message : "Workgraph network request failed");
  }
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const code = typeof obj.code === "string" ? obj.code : undefined;
    throw new WorkgraphError(responseMessage(parsed, raw, res.statusText), res.status, code);
  }
  if (parseError) {
    throw new WorkgraphError(invalidApiResponseMessage(url, raw, parseError), res.status, "INVALID_API_RESPONSE");
  }
  return parsed as T;
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
