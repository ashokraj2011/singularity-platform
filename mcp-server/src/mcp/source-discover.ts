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

export const sourceDiscoverRouter: Router = Router();

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
  const token = process.env.GITHUB_TOKEN?.trim();
  return {
    "user-agent": "singularity-mcp-server",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
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
    const { owner, repo } = parseGitHubRepo(repoUrl);
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const resp = await fetch(url, { headers: githubHeaders({ accept: "application/vnd.github+json" }) });
    if (!resp.ok) {
      throw new AppError(`GitHub tree lookup failed (${resp.status})`, 502, "UPSTREAM_ERROR");
    }
    const body = (await resp.json()) as { tree?: Array<{ path?: string; type?: string; size?: number }> };
    const tree = (body.tree ?? []).map(item => ({
      path: item.path ?? "",
      type: item.type ?? "",
      size: item.size ?? 0,
    }));
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
    const { owner, repo } = parseGitHubRepo(repoUrl);
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const resp = await fetch(raw, { headers: githubHeaders() });
    if (!resp.ok) {
      // A missing/forbidden file is non-fatal for discovery — mirror the prior
      // agent-runtime fetchGitHubRaw behaviour and return empty content.
      res.json({ content: "" });
      return;
    }
    const content = await resp.text();
    res.json({ content });
  } catch (err) {
    next(err);
  }
});
