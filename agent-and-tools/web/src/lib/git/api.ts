"use client";

import { apiPath, authHeaders, invalidApiResponseMessage, readResponseBody, responseMessage } from "@/lib/api";

/**
 * Git Credential Broker admin API (P0 #2, slice E).
 *
 * The broker endpoints live on the IAM service under `/api/v1/git/*`, so these
 * calls ride the existing `/api/iam/[...path]` proxy — `/api/iam/git/connections`
 * forwards to `${IAM_BASE_URL}/git/connections`. Both resources are
 * `require_super_admin` server-side; the proxy forwards the caller's verified
 * bearer (never a service token), and the pages are super-admin gated client-side.
 */

export type GitConnection = {
  id: string;
  tenantId: string;
  provider: string;
  appId: string;
  installationId: string;
  accountLogin?: string | null;
  status: string;
};

export type CreateGitConnectionRequest = {
  tenantId: string;
  appId: string;
  installationId: string;
  accountLogin?: string;
  privateKey: string;
  provider?: string;
};

export type GitSubjectType = "user" | "team" | "capability";

export type RepositoryGrant = {
  id: string;
  tenantId: string;
  subjectType: string;
  subjectId: string;
  repo: string;
  operations: string[];
  status: string;
};

export type CreateRepositoryGrantRequest = {
  tenantId: string;
  subjectType: GitSubjectType;
  subjectId: string;
  repo: string;
  operations: string[];
};

export class GitBrokerError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "GitBrokerError";
  }
}

async function gitRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `/api/iam/git${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
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
    throw new GitBrokerError(err instanceof Error ? err.message : "Git broker network request failed");
  }
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    throw new GitBrokerError(
      responseMessage(parsed, raw, res.statusText),
      res.status,
      typeof obj.code === "string" ? obj.code : undefined,
    );
  }
  if (parseError) {
    throw new GitBrokerError(invalidApiResponseMessage(url, raw, parseError), res.status, "INVALID_API_RESPONSE");
  }
  return parsed as T;
}

export function listGitConnections(tenantId?: string): Promise<GitConnection[]> {
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return gitRequest<GitConnection[]>(`/connections${qs}`);
}

export function createGitConnection(body: CreateGitConnectionRequest): Promise<GitConnection> {
  return gitRequest<GitConnection>("/connections", { method: "POST", body: JSON.stringify(body) });
}

export function listRepositoryGrants(tenantId?: string): Promise<RepositoryGrant[]> {
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return gitRequest<RepositoryGrant[]>(`/repository-grants${qs}`);
}

export function createRepositoryGrant(body: CreateRepositoryGrantRequest): Promise<RepositoryGrant> {
  return gitRequest<RepositoryGrant>("/repository-grants", { method: "POST", body: JSON.stringify(body) });
}
