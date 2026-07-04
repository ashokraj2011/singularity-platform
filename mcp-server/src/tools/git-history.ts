import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveSandboxedPath, sandboxRoot } from "../workspace/sandbox";
import type { ToolHandler } from "./registry";

const execFileP = promisify(execFile);
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

type Commit = {
  sha: string;
  short: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
};

type FileStat = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  churn: number;
};

type CategorySummary = {
  name: string;
  commitCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  subjects: string[];
  files: string[];
};

type GitFailure = Error & {
  code?: string | number;
  signal?: string;
  stdout?: string;
  stderr?: string;
};

async function runGit(repo: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number | string }> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: 60_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const error = err as GitFailure;
    if (allowFailure) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
        code: error.code ?? 1,
      };
    }
    throw err;
  }
}

function normalizeDate(raw: string, endOfDay: boolean): string {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value} ${endOfDay ? "23:59:59" : "00:00:00"}`;
  }
  return value;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\0\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function cleanPath(value: unknown): string | null {
  const text = cleanText(value, 260);
  if (!text || path.isAbsolute(text) || text.split(/[\\/]+/).includes("..")) return null;
  return text;
}

function clampMaxCommits(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number(value);
  const fallback = Number.isFinite(parsed) ? parsed : 250;
  return Math.max(1, Math.min(fallback, 500));
}

function normalizeRenamePath(filePath: string): string {
  if (!filePath.includes(" => ")) return filePath;
  if (filePath.startsWith("{") && filePath.includes("}")) return filePath;
  return filePath.split(" => ", 2)[1] ?? filePath;
}

function categoryForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (
    lower.startsWith("agent-and-tools/web/") ||
    lower.startsWith("workgraph-studio/apps/web/") ||
    lower.startsWith("workgraph-studio/apps/blueprint-workbench/")
  ) return "Frontend / Platform Web";
  if (lower.startsWith("workgraph-studio/") || lower.includes("/workflow") || lower.includes("/planner")) {
    return "Workflow / Workgraph";
  }
  if (
    lower.startsWith("agent-and-tools/apps/agent-runtime/") ||
    lower.startsWith("agent-and-tools/apps/agent-service/") ||
    lower.startsWith("agent-and-tools/apps/tool-service/")
  ) return "Agent Runtime / Tools";
  if (
    lower.startsWith("context-fabric/") ||
    lower.startsWith("mcp-server/") ||
    lower.startsWith("llm-gateway/") ||
    lower.includes("runtime-bridge")
  ) return "Context Fabric / MCP / LLM";
  if (
    lower.startsWith("singularity-iam-service/") ||
    lower.startsWith("audit-governance-service/") ||
    lower.includes("/identity/") ||
    lower.includes("governance")
  ) return "Identity / Governance / Audit";
  if (
    lower.startsWith("bin/") ||
    lower.includes("docker") ||
    lower.includes("compose") ||
    lower.endsWith(".sh") ||
    lower.endsWith("dockerfile") ||
    lower.includes("nginx")
  ) return "Deployment / Scripts / Docker";
  if (lower.startsWith("docs/") || lower.endsWith(".md") || lower.endsWith(".html")) return "Docs";
  if (lower.includes("test") || lower.includes("spec") || lower.startsWith("tests/")) return "Tests / Verification";
  if (lower.includes("prisma") || lower.includes("migration") || lower.includes("seed") || lower.endsWith(".sql")) {
    return "Data / Migrations / Seeds";
  }
  return "Other";
}

async function resolveRepo(repoPath: unknown): Promise<string> {
  const root = sandboxRoot();
  const scoped = cleanPath(repoPath) ? resolveSandboxedPath(String(repoPath)) : root;
  const result = await runGit(scoped, ["rev-parse", "--show-toplevel"]);
  const repo = path.resolve(result.stdout.trim());
  const rel = path.relative(root, repo);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("resolved git repository escapes the MCP sandbox root");
  }
  return repo;
}

async function loadCommitFiles(repo: string, sha: string, paths: string[]): Promise<string[]> {
  const args = ["show", "--pretty=format:", "--name-only", "--diff-filter=ACMRTUXB", sha];
  if (paths.length) args.push("--", ...paths);
  const proc = await runGit(repo, args, true);
  if (proc.code !== 0) return [];
  return [...new Set(proc.stdout.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

async function loadCommits(
  repo: string,
  since: string,
  until: string,
  paths: string[],
  author: string | null,
  noMerges: boolean,
  maxCommits: number,
): Promise<Commit[]> {
  const args = [
    "log",
    "--reverse",
    `--since=${since}`,
    `--until=${until}`,
    "--date=iso-strict",
    `--max-count=${maxCommits}`,
    `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%ad${FIELD_SEP}%an${FIELD_SEP}%s${RECORD_SEP}`,
  ];
  if (author) args.push(`--author=${author}`);
  if (noMerges) args.push("--no-merges");
  if (paths.length) args.push("--", ...paths);

  const proc = await runGit(repo, args);
  const commits: Commit[] = [];
  for (const raw of proc.stdout.split(RECORD_SEP)) {
    const record = raw.trim();
    if (!record) continue;
    const parts = record.split(FIELD_SEP);
    if (parts.length !== 5) continue;
    const [sha, short, date, commitAuthor, subject] = parts;
    commits.push({ sha, short, date, author: commitAuthor, subject, files: [] });
  }

  return await Promise.all(
    commits.map(async (commit) => ({
      ...commit,
      files: await loadCommitFiles(repo, commit.sha, paths),
    })),
  );
}

async function firstParentOrEmptyTree(repo: string, sha: string): Promise<string> {
  const proc = await runGit(repo, ["rev-parse", `${sha}^`], true);
  return proc.code === 0 && proc.stdout.trim() ? proc.stdout.trim() : EMPTY_TREE;
}

async function loadFileStats(repo: string, commits: Commit[], paths: string[]): Promise<FileStat[]> {
  if (commits.length === 0) return [];
  const base = await firstParentOrEmptyTree(repo, commits[0].sha);
  const head = commits[commits.length - 1]?.sha;
  if (!head) return [];
  const args = ["diff", "--numstat", "--find-renames", base, head];
  if (paths.length) args.push("--", ...paths);
  const proc = await runGit(repo, args);
  const stats: FileStat[] = [];
  for (const line of proc.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [additionsRaw, deletionsRaw] = parts;
    const filePath = parts.slice(2).join("\t");
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    const additions = binary ? 0 : Number(additionsRaw);
    const deletions = binary ? 0 : Number(deletionsRaw);
    stats.push({
      path: normalizeRenamePath(filePath),
      additions,
      deletions,
      binary,
      churn: additions + deletions,
    });
  }
  return stats.sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path));
}

function buildCategories(commits: Commit[], stats: FileStat[]): CategorySummary[] {
  const statsByPath = new Map(stats.map((item) => [item.path, item]));
  const commitsByCategory = new Map<string, Commit[]>();
  const filesByCategory = new Map<string, Set<string>>();

  for (const commit of commits) {
    const categories = commit.files.length ? new Set(commit.files.map(categoryForPath)) : new Set(["Other"]);
    for (const category of categories) {
      commitsByCategory.set(category, [...(commitsByCategory.get(category) ?? []), commit]);
    }
    for (const file of commit.files) {
      const category = categoryForPath(file);
      const files = filesByCategory.get(category) ?? new Set<string>();
      files.add(file);
      filesByCategory.set(category, files);
    }
  }

  const summaries: CategorySummary[] = [];
  for (const [category, categoryCommits] of commitsByCategory.entries()) {
    const files = [...(filesByCategory.get(category) ?? new Set<string>())].sort();
    const additions = files.reduce((sum, file) => sum + (statsByPath.get(file)?.additions ?? 0), 0);
    const deletions = files.reduce((sum, file) => sum + (statsByPath.get(file)?.deletions ?? 0), 0);
    const seenSubjects = new Set<string>();
    const subjects: string[] = [];
    for (const commit of [...categoryCommits].reverse()) {
      if (seenSubjects.has(commit.subject)) continue;
      subjects.push(commit.subject);
      seenSubjects.add(commit.subject);
      if (subjects.length >= 5) break;
    }
    const hotFiles = [...files]
      .sort((a, b) => (statsByPath.get(b)?.churn ?? 0) - (statsByPath.get(a)?.churn ?? 0) || a.localeCompare(b))
      .slice(0, 8);
    summaries.push({
      name: category,
      commitCount: new Set(categoryCommits.map((commit) => commit.sha)).size,
      fileCount: files.length,
      additions,
      deletions,
      subjects,
      files: hotFiles,
    });
  }

  return summaries.sort((a, b) => b.commitCount - a.commitCount || b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

function riskSignals(commits: Commit[], stats: FileStat[]): string[] {
  const subjects = commits.map((commit) => commit.subject.toLowerCase()).join(" ");
  const lowerPaths = stats.map((item) => item.path.toLowerCase()).join(" ");
  const haystack = `${subjects} ${lowerPaths}`;
  const signals: string[] = [];
  if (/\b(auth|jwt|token|secret|permission|tenant|rls)\b/.test(haystack)) {
    signals.push("Security/auth/tenant-sensitive files or commit messages changed.");
  }
  if (/\b(migration|prisma|schema|seed|\.sql)\b/.test(lowerPaths)) {
    signals.push("Database schema, migration, seed, or Prisma files changed.");
  }
  if (/\b(docker|compose|nginx|bare-metal|setup|doctor|deploy)\b/.test(haystack)) {
    signals.push("Deployment, container, or operator script behavior changed.");
  }
  if (/\b(context-fabric|runtime-bridge|mcp|llm|gateway)\b/.test(haystack)) {
    signals.push("Runtime fabric, MCP, or LLM routing changed.");
  }
  if (stats.some((item) => item.deletions > item.additions * 3 && item.deletions > 120)) {
    signals.push("Large deletion-heavy file changes exist; review for removed behavior or route loss.");
  }
  return signals.length ? signals : ["No high-risk signals detected from paths or commit subjects."];
}

function suggestedVerification(categories: CategorySummary[]): string[] {
  const names = new Set(categories.map((category) => category.name));
  const checks: string[] = [];
  if (names.has("Frontend / Platform Web")) {
    checks.push("cd agent-and-tools/web && npm run build", "cd agent-and-tools/web && npm run test:routes");
  }
  if (names.has("Workflow / Workgraph")) {
    checks.push("Run Workgraph API tests or at minimum open /workflows, /workflows/start, and /runs in Platform Web.");
  }
  if (names.has("Context Fabric / MCP / LLM")) {
    checks.push("Run Context Fabric/MCP runtime bridge smoke with X-Service-Token on /api/runtime-bridge/status, then test one tool-run/model-run path.");
  }
  if (names.has("Agent Runtime / Tools")) {
    checks.push("Run agent profile/tool lifecycle smoke checks and verify /agents/studio.");
  }
  if (names.has("Deployment / Scripts / Docker")) {
    checks.push("Run bin/doctor.sh plus the relevant docker/bare-metal smoke command.");
  }
  if (names.has("Data / Migrations / Seeds")) {
    checks.push("Apply migrations/seeds in a disposable clone or database before release.");
  }
  if (names.has("Identity / Governance / Audit")) {
    checks.push("Verify IAM login/token minting and audit-governance health.");
  }
  return checks.length ? checks : ["Review changed files and run the nearest service/unit tests for touched areas."];
}

function authorCounts(commits: Commit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const commit of commits) counts[commit.author] = (counts[commit.author] ?? 0) + 1;
  return counts;
}

function markdownReport(
  repo: string,
  since: string,
  until: string,
  commits: Commit[],
  stats: FileStat[],
  categories: CategorySummary[],
  risks: string[],
  checks: string[],
  paths: string[],
): string {
  const additions = stats.reduce((sum, item) => sum + item.additions, 0);
  const deletions = stats.reduce((sum, item) => sum + item.deletions, 0);
  const authors = authorCounts(commits);
  const dominant = categories.slice(0, 3).map((category) => category.name).join(", ") || "none";
  const scope = paths.length ? paths.join(", ") : "entire repository";
  const lines = [
    "# Git History Change Explanation",
    "",
    `- Repository: \`${repo}\``,
    `- Date range: \`${since}\` -> \`${until}\``,
    `- Scope: \`${scope}\``,
    `- Commits: \`${commits.length}\``,
    `- Files changed: \`${stats.length}\``,
    `- Line churn: \`+${additions} / -${deletions}\``,
    "",
    "## Executive Summary",
    "",
  ];

  if (commits.length) {
    lines.push(
      `Between the selected dates, the main work landed in **${dominant}**.`,
      `The range includes **${commits.length} commit(s)** from **${Object.keys(authors).length} author(s)** and changes **${stats.length} file(s)** with **+${additions}/-${deletions}** cumulative line churn.`,
    );
  } else {
    lines.push("No commits matched the selected date range and path filters.");
  }

  lines.push("", "## Category Breakdown", "");
  if (categories.length) {
    for (const category of categories) {
      lines.push(
        `### ${category.name}`,
        `- Commits: \`${category.commitCount}\`; files: \`${category.fileCount}\`; churn: \`+${category.additions}/-${category.deletions}\``,
      );
      if (category.subjects.length) {
        lines.push("- Recent subjects:");
        lines.push(...category.subjects.map((subject) => `  - ${subject}`));
      }
      if (category.files.length) {
        lines.push("- Hot files:");
        lines.push(...category.files.map((file) => `  - \`${file}\``));
      }
      lines.push("");
    }
  } else {
    lines.push("_No category data._", "");
  }

  lines.push("## Risk Signals", "", ...risks.map((signal) => `- ${signal}`));
  lines.push("", "## Suggested Verification", "", ...checks.map((check) => `- ${check}`));
  lines.push("", "## Commit Timeline", "");
  if (commits.length) {
    lines.push("| Date | Commit | Author | Subject |", "|---|---|---|---|");
    for (const commit of commits) {
      const date = commit.date.split("T", 1)[0];
      lines.push(`| ${date} | \`${commit.short}\` | ${commit.author} | ${commit.subject.replace(/\|/g, "\\|")} |`);
    }
  } else {
    lines.push("_No commits._");
  }

  lines.push("", "## Top Changed Files", "");
  if (stats.length) {
    lines.push("| File | + | - |", "|---|---:|---:|");
    for (const item of stats.slice(0, 40)) {
      lines.push(`| \`${item.path}\` | ${item.binary ? "binary" : item.additions} | ${item.binary ? "binary" : item.deletions} |`);
    }
  } else {
    lines.push("_No file changes._");
  }

  lines.push("");
  return lines.join("\n");
}

function buildParsed(
  repo: string,
  since: string,
  until: string,
  commits: Commit[],
  stats: FileStat[],
  categories: CategorySummary[],
  risks: string[],
  checks: string[],
  paths: string[],
): Record<string, unknown> {
  return {
    repository: repo,
    since,
    until,
    scope: paths.length ? paths : ["."],
    summary: {
      commits: commits.length,
      filesChanged: stats.length,
      additions: stats.reduce((sum, item) => sum + item.additions, 0),
      deletions: stats.reduce((sum, item) => sum + item.deletions, 0),
      authors: authorCounts(commits),
    },
    categories,
    riskSignals: risks,
    suggestedVerification: checks,
    commits,
    files: stats,
  };
}

export const gitHistoryExplainTool: ToolHandler = {
  descriptor: {
    name: "git_history_explain",
    description: "Explain changes between two dates using only read-only git history in the MCP runtime workspace.",
    natural_language:
      "Use this when a user asks what changed between two dates, needs release notes, or wants delivery evidence from git history. It only runs git log/show/diff and does not modify files.",
    input_schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Start date/time, for example 2026-06-20" },
        until: { type: "string", description: "End date/time, for example 2026-07-02" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional sandbox-relative repository paths to scope the report.",
        },
        author: { type: "string", description: "Optional git author filter." },
        no_merges: { type: "boolean", description: "Exclude merge commits." },
        max_commits: { type: "number", description: "Maximum commits to explain. Default 250, max 500." },
        format: { type: "string", enum: ["markdown", "json"], description: "Report format." },
        repo_path: { type: "string", description: "Optional sandbox-relative repo path. Defaults to the current workspace root." },
      },
      required: ["since", "until"],
    },
    output_schema: {
      type: "object",
      properties: {
        report: { type: "string" },
        parsed: { type: "object" },
        repo: { type: "string" },
        format: { type: "string" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    try {
      const sinceRaw = cleanText(args.since, 80);
      const untilRaw = cleanText(args.until, 80);
      if (!sinceRaw || !untilRaw) throw new Error("since and until are required");

      const rawPaths = Array.isArray(args.paths) ? args.paths : (args.path ? [args.path] : []);
      const paths = rawPaths.map(cleanPath).filter((item): item is string => Boolean(item));
      const author = cleanText(args.author, 120);
      const noMerges = Boolean(args.no_merges ?? args.noMerges);
      const maxCommits = clampMaxCommits(args.max_commits ?? args.maxCommits);
      const format = args.format === "json" ? "json" : "markdown";
      const repo = await resolveRepo(args.repo_path ?? args.repoPath);
      const since = normalizeDate(sinceRaw, false);
      const until = normalizeDate(untilRaw, true);
      const commits = await loadCommits(repo, since, until, paths, author, noMerges, maxCommits);
      const stats = await loadFileStats(repo, commits, paths);
      const categories = buildCategories(commits, stats);
      const risks = riskSignals(commits, stats);
      const checks = suggestedVerification(categories);
      const parsed = buildParsed(repo, since, until, commits, stats, categories, risks, checks, paths);
      const report = format === "json"
        ? JSON.stringify(parsed, null, 2)
        : markdownReport(repo, since, until, commits, stats, categories, risks, checks, paths);

      return {
        success: true,
        output: {
          generatedAt: new Date().toISOString(),
          executionPath: "context-fabric-runtime-bridge",
          repo,
          format,
          report,
          parsed: format === "json" ? parsed : null,
          stderr: null,
        },
      };
    } catch (err) {
      const error = err as GitFailure;
      return {
        success: false,
        output: null,
        error: error.stderr?.trim() || error.message || "git history explanation failed",
        error_code: "VALIDATION",
      };
    }
  },
};
