"use client";

import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

export type FoundryMode = "ALL" | "GREENFIELD" | "BROWNFIELD";

export interface RunSummary {
  id: string;
  specId: string;
  specName?: string;
  specVersion?: string;
  specKind?: string;
  mode: "GREENFIELD" | "BROWNFIELD";
  status: string;
  templateVersion: string;
  generatorVersion: string;
  outputPath: string | null;
  startedAt: string;
  completedAt: string | null;
  brownfieldPlanId: string | null;
}

export interface RunDetail extends RunSummary {
  spec?: { specName?: string; version?: string; kind?: string; specHash?: string; irHash?: string | null };
  receipt?: { id: string; receiptHash: string; createdAt: string } | null;
  changePlan?: { id: string; status: string; planHash: string; repoModelId: string } | null;
  counts: { artifacts: number; gaps: number; openGaps: number; llmTasks: number; openLlmTasks: number };
}

export interface ArtifactRow {
  id: string;
  path: string;
  contentHash: string;
  fileType: string;
  protected: boolean;
  createdAt: string;
}

export interface GapRow {
  id: string;
  gapType: string;
  severity: "low" | "medium" | "high" | "critical";
  filePath: string | null;
  className: string | null;
  methodName: string | null;
  regionId: string | null;
  description: string;
  recommendedResolution: string | null;
  llmEligible: boolean;
  resolved: boolean;
  createdAt: string;
}

export interface LlmTaskRow {
  id: string;
  runId: string;
  gapId: string | null;
  taskType: string;
  status: "PENDING" | "DISPATCHED" | "GUARD_PASSED" | "GUARD_REJECTED" | "CANCELLED" | "FAILED";
  targetFile: string;
  targetClass: string | null;
  targetMethod: string | null;
  regionId: string;
  allowedChanges: unknown;
  forbiddenChanges: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export interface RepoModelSummary {
  id: string;
  repoPath: string;
  language: string;
  framework: string;
  modelHash: string;
  scannedAt: string;
}

export interface ChangePlanSummary {
  id: string;
  repoModelId: string;
  planHash: string;
  enhancementSpecHash: string;
  status: "PROPOSED" | "PARTIALLY_APPLIED" | "APPLIED" | "FAILED" | "REJECTED";
  createdAt: string;
  appliedAt: string | null;
}

export interface SpecLifecycleEvent {
  id: string;
  specId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

export class FoundryError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "FoundryError";
  }
}

async function foundryRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    throw new FoundryError(
      responseMessage(parsed, raw, res.statusText),
      res.status,
      typeof obj.code === "string" ? obj.code : undefined,
    );
  }
  return parsed as T;
}

export const foundryApi = {
  listRuns: (params: { take?: number; skip?: number; mode?: FoundryMode; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.take !== undefined) q.set("take", String(params.take));
    if (params.skip !== undefined) q.set("skip", String(params.skip));
    if (params.mode && params.mode !== "ALL") q.set("mode", params.mode);
    if (params.status) q.set("status", params.status);
    return foundryRequest<{ total: number; take: number; skip: number; items: RunSummary[] }>(`/api/codegen/runs?${q.toString()}`);
  },
  getRun: (runId: string) => foundryRequest<RunDetail>(`/api/codegen/runs/${encodeURIComponent(runId)}`),
  listArtifacts: (runId: string) => foundryRequest<{ runId: string; outputPath: string | null; items: ArtifactRow[] }>(`/api/codegen/runs/${encodeURIComponent(runId)}/artifacts`),
  fileContent: (runId: string, path: string) => foundryRequest<{ path: string; bytes: number; content: string; modifiedAt: string }>(`/api/codegen/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}`),
  listGaps: (runId: string) => foundryRequest<{ runId: string; items: GapRow[] }>(`/api/codegen/runs/${encodeURIComponent(runId)}/gaps`),
  listLlmTasks: (runId: string) => foundryRequest<{ runId: string; items: LlmTaskRow[] }>(`/api/codegen/runs/${encodeURIComponent(runId)}/llm-tasks`),
  receipt: (runId: string) => foundryRequest<{ id: string; receiptJson: Record<string, unknown>; receiptHash: string; createdAt: string }>(`/api/codegen/runs/${encodeURIComponent(runId)}/receipt`),
  dispatchTask: (taskId: string) => foundryRequest<{ taskId: string; status: string; diff?: string; error?: string }>(`/api/codegen/llm-tasks/${encodeURIComponent(taskId)}/dispatch`, { method: "POST", body: "{}" }),
  applyPatch: (taskId: string, diff: string) => foundryRequest<{ taskId: string; status: "GUARD_PASSED" | "GUARD_REJECTED"; stage?: string; reason?: string; appliedFiles?: Array<{ path: string; beforeHash: string; afterHash: string }> }>(
    `/api/codegen/llm-tasks/${encodeURIComponent(taskId)}/apply-patch`,
    { method: "POST", body: JSON.stringify({ diff }) },
  ),
  listRepos: () => foundryRequest<{ items: RepoModelSummary[] }>("/api/codegen/repos"),
  listChangePlans: (repoModelId?: string) => foundryRequest<{ items: ChangePlanSummary[] }>(`/api/codegen/change-plans${repoModelId ? `?repoModelId=${encodeURIComponent(repoModelId)}` : ""}`),
  listSpecHistory: (specId: string) => foundryRequest<{ items: SpecLifecycleEvent[] }>(`/api/codegen/specs/${encodeURIComponent(specId)}/history`),
};
