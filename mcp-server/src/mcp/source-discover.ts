/**
 * Centralized GitHub source discovery for capability onboarding.
 *
 * Platform policy: GitHub egress only happens through the MCP server — even
 * during capability onboarding. agent-runtime's bootstrap discovery used to
 * call api.github.com (repo tree) and raw.githubusercontent.com (file
 * contents) DIRECTLY. These two endpoints relocate that egress here so the
 * MCP server is the single component that talks to GitHub, and the place a
 * GITHUB_TOKEN (rate limits / private repos) lives.
 *
 *   POST /mcp/source/tree  { repoUrl, branch }        -> { tree: [{ path, type, size }] }
 *   POST /mcp/source/file  { repoUrl, branch, path }  -> { content }   ("" when missing)
 *
 * Mounted under /mcp, so bearerAuth (app.ts) already gates these. They are
 * read-only, so they ride the resources:read scope alongside the worktree
 * read endpoints.
 */
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../shared/errors";
import { isSharedRuntime, gitBrokerEnforce, staticGitToken } from "../lib/runtime-claims";
import { readUpstreamJsonBody, upstreamSnippet } from "../lib/upstream-json";
import { config } from "../config";

export const sourceDiscoverRouter: Router = Router();
const SOURCE_DISCOVERY_TIMEOUT_MS = config.MCP_SOURCE_DISCOVERY_TIMEOUT_MS;

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new AppError("repoUrl must be a valid URL", 400, "VALIDATION_ERROR");
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw new AppError("Only github.com repositories are supported", 400, "VALIDATION_ERROR");
  }
  const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) {
    throw new AppError("GitHub URL must include owner and repository", 400, "VALIDATION_ERROR");
  }
  return { owner, repo: repoRaw.replace(/\.git$/i, "") };
}

function githubHeaders(extra?: Record<string, string>): Record<string, string> {
  // P0 #2 — a shared runtime under broker enforcement must NOT use a process-global
  // git token (it would attribute every user's fetch to one identity). The boot
  // guard already refuses to start in that case; this is defense-in-depth for
  // all supported static-token envs, not only GITHUB_TOKEN.
  const token = isSharedRuntime() && gitBrokerEnforce() ? undefined : staticGitToken()?.value;
  return {
    "user-agent": "singularity-mcp-server",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

export type SourceTreeEntry = { path: string; type: string; size: number };

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = SOURCE_DISCOVERY_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(`GitHub request timed out or failed: ${message}`, 502, "UPSTREAM_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

async function readGitHubJson<T>(resp: Response, source: string): Promise<T> {
  const body = await readUpstreamJsonBody(resp);
  if (!body.raw.trim()) {
    throw new AppError(`${source} returned an empty response (${resp.status})`, 502, "UPSTREAM_INVALID_RESPONSE");
  }
  if (body.parseError) {
    throw new AppError(
      `${source} returned invalid JSON (${resp.status}): ${body.parseError}; body=${upstreamSnippet(body.raw, 300)}`,
      502,
      "UPSTREAM_INVALID_RESPONSE",
    );
  }
  if (body.data && typeof body.data === "object") return body.data as T;
  throw new AppError(
    `${source} returned invalid JSON (${resp.status}): response JSON was not an object; body=${upstreamSnippet(body.raw, 300)}`,
    502,
    "UPSTREAM_INVALID_RESPONSE",
  );
}

// Reusable repo-tree fetch — used by BOTH the HTTP /source/tree route and the
// laptop relay-client's `source-tree` bridge frame, so capability repo discovery
// behaves identically whether the caller reaches mcp over HTTP (co-located) or
// over the CF bridge (cloud control plane → laptop runtime). GitHub egress uses
// this process's GITHUB_TOKEN — which, on the laptop, never leaves the laptop.
export async function fetchGitHubTree(repoUrl: string, branch: string): Promise<SourceTreeEntry[]> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const resp = await fetchWithTimeout(url, { headers: githubHeaders({ accept: "application/vnd.github+json" }) });
  if (!resp.ok) {
    throw new AppError(`GitHub tree lookup failed (${resp.status})`, 502, "UPSTREAM_ERROR");
  }
  const body = await readGitHubJson<{ tree?: Array<{ path?: string; type?: string; size?: number }> }>(resp, "GitHub tree lookup");
  return (body.tree ?? []).map(item => ({
    path: item.path ?? "",
    type: item.type ?? "",
    size: item.size ?? 0,
  }));
}

// List the repo's branches via the GitHub API — same auth as fetchGitHubTree (the
// runtime's own token). Powers the launch "Branch to clone" picker over the bridge,
// so no separate connector is needed. Returns up to 100 branch names.
export async function fetchGitHubBranches(repoUrl: string): Promise<string[]> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`;
  const resp = await fetchWithTimeout(url, { headers: githubHeaders({ accept: "application/vnd.github+json" }) });
  if (!resp.ok) {
    throw new AppError(`GitHub branch lookup failed (${resp.status})`, 502, "UPSTREAM_ERROR");
  }
  const body = await readGitHubJson<Array<{ name?: string }>>(resp, "GitHub branch lookup");
  return (Array.isArray(body) ? body : []).map(b => b?.name ?? "").filter(Boolean);
}

// Reusable single-file fetch (see fetchGitHubTree). A missing/forbidden file is
// non-fatal for discovery — returns "" rather than throwing.
export async function fetchGitHubFile(repoUrl: string, branch: string, path: string): Promise<string> {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const encodedPath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const contents = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const resp = await fetchWithTimeout(contents, { headers: githubHeaders({ accept: "application/vnd.github+json" }) });
  if (resp.status === 404) return "";
  if (resp.status === 403) {
    throw new AppError(`GitHub file lookup forbidden or rate limited (${githubRateLimitHint(resp)})`, 502, "UPSTREAM_ERROR");
  }
  if (!resp.ok) {
    throw new AppError(`GitHub file lookup failed (${resp.status})`, 502, "UPSTREAM_ERROR");
  }
  const body = await readGitHubJson<{
    type?: string;
    content?: string;
    encoding?: string;
    download_url?: string | null;
  } | Array<unknown>>(resp, "GitHub file lookup");
  if (Array.isArray(body) || body.type !== "file") return "";
  if (body.encoding === "base64" && typeof body.content === "string") {
    return Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (typeof body.content === "string" && body.content.length > 0) return body.content;
  // Large files may omit inline base64 content. Stay on api.github.com instead
  // of following download_url to raw.githubusercontent.com; the latter is often
  // blocked separately on enterprise networks and bypasses GitHub API headers.
  const rawResp = await fetchWithTimeout(contents, { headers: githubHeaders({ accept: "application/vnd.github.raw" }) });
  if (rawResp.status === 404) return "";
  if (rawResp.status === 403) {
    throw new AppError(`GitHub raw file lookup forbidden or rate limited (${githubRateLimitHint(rawResp)})`, 502, "UPSTREAM_ERROR");
  }
  if (!rawResp.ok) {
    throw new AppError(`GitHub raw file lookup failed (${rawResp.status})`, 502, "UPSTREAM_ERROR");
  }
  return rawResp.text();
}

function githubRateLimitHint(resp: Response): string {
  const remaining = resp.headers.get("x-ratelimit-remaining");
  const reset = resp.headers.get("x-ratelimit-reset");
  const resource = resp.headers.get("x-ratelimit-resource");
  const parts = [
    resource ? `resource=${resource}` : null,
    remaining ? `remaining=${remaining}` : null,
    reset ? `reset=${reset}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "check GitHub token, SSO, and rate limits";
}

const treeSchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().min(1).default("main"),
});

sourceDiscoverRouter.post("/source/tree", async (req, res, next) => {
  try {
    const parsed = treeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("invalid /source/tree payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
    }
    const { repoUrl, branch } = parsed.data;
    const tree = await fetchGitHubTree(repoUrl, branch);
    res.json({ tree });
  } catch (err) {
    next(err);
  }
});

const fileSchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().min(1).default("main"),
  path: z.string().min(1),
});

sourceDiscoverRouter.post("/source/file", async (req, res, next) => {
  try {
    const parsed = fileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("invalid /source/file payload", 400, "VALIDATION_ERROR", parsed.error.flatten());
    }
    const { repoUrl, branch, path } = parsed.data;
    const content = await fetchGitHubFile(repoUrl, branch, path);
    res.json({ content });
  } catch (err) {
    next(err);
  }
});
