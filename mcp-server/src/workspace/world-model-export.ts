/**
 * Export the layered world model into the workspace as `.agent/world-model/`.
 *
 * The DB is the system of record; this is the second half of the hybrid. Agents
 * that reach the code through a filesystem rather than through prompt-composer —
 * a laptop CLI, a `cat`, a grep — cannot call the slice endpoint, so the views
 * are also written next to the code they describe.
 *
 * Three properties this file exists to guarantee:
 *
 *  - It NEVER throws. Export is an enhancement layered onto grounding; a failure
 *    here must not fail the ground that produced a perfectly good workspace.
 *  - It re-runs on every ground. The central workspace is wiped and re-cloned on
 *    re-ground, so a one-time export would silently disappear.
 *  - It excludes itself from git via `.git/info/exclude`, NOT `.gitignore`.
 *    `.gitignore` is the repository's own tracked file; writing to it would put
 *    a spurious diff in front of every agent that runs `git status` and could
 *    end up committed. `info/exclude` is local-only and invisible to the repo.
 */

import fs from "node:fs";
import path from "node:path";

const EXPORT_TIMEOUT_MS = 10_000;
const AGENT_DIR = ".agent";
const WORLD_MODEL_DIR = path.join(AGENT_DIR, "world-model");

type ExportedView = {
  kind: string;
  domainKey: string;
  title: string;
  contentMd: string;
  status?: string;
  stale?: boolean;
  tokenEstimate?: number;
  contentHash?: string | null;
  sourceCommit?: string | null;
  generatedAt?: string;
  evidence?: unknown;
  structured?: unknown;
};

export type ExportResult = {
  exported: boolean;
  reason?: string;
  files: number;
  views: number;
};

/** Filesystem-safe slug for a domain or task key, which is free text. */
function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "unnamed";
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
      return (body as Record<string, unknown>).data;
    }
    return body;
  } catch {
    return null;
  }
}

/**
 * Add `.agent/` to `.git/info/exclude` if it is not already there.
 *
 * Idempotent by content check rather than by a marker comment, so re-running
 * never grows the file. A missing `.git` directory is not an error — a workspace
 * materialised without git history simply has nothing to exclude from.
 */
export function excludeAgentDirFromGit(workspaceRoot: string): boolean {
  try {
    const infoDir = path.join(workspaceRoot, ".git", "info");
    if (!fs.existsSync(path.join(workspaceRoot, ".git"))) return false;
    fs.mkdirSync(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, "exclude");
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const lines = current.split("\n").map((l) => l.trim());
    if (lines.includes(`${AGENT_DIR}/`) || lines.includes(AGENT_DIR)) return true;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}# Exported capability world model (generated, not part of the repo)\n${AGENT_DIR}/\n`);
    return true;
  } catch {
    return false;
  }
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

/** One view's markdown, with its provenance in front matter the reader can see. */
function renderViewMarkdown(view: ExportedView): string {
  const front = [
    "---",
    `kind: ${view.kind}`,
    ...(view.domainKey ? [`domainKey: ${view.domainKey}`] : []),
    `title: ${view.title}`,
    ...(view.sourceCommit ? [`sourceCommit: ${view.sourceCommit}`] : []),
    ...(view.generatedAt ? [`generatedAt: ${view.generatedAt}`] : []),
    ...(view.stale ? ["stale: true"] : []),
    "---",
    "",
  ];
  const staleNote = view.stale
    ? ["> This view was built against an earlier revision of the repository and may be out of date.", ""]
    : [];
  return [...front, `# ${view.title}`, "", ...staleNote, view.contentMd.trim(), ""].join("\n");
}

/** Where a view lands. Role views sit together; the keyed kinds get their own folders. */
function viewRelPath(view: ExportedView): string {
  if (view.kind === "domain") return path.join(WORLD_MODEL_DIR, "domains", `${slugify(view.domainKey)}.md`);
  if (view.kind === "task_guide") return path.join(WORLD_MODEL_DIR, "task-guides", `${slugify(view.domainKey)}.md`);
  if (view.kind === "core_summary") return path.join(WORLD_MODEL_DIR, "core", "summary.md");
  return path.join(WORLD_MODEL_DIR, "views", `${slugify(view.kind)}.md`);
}

/**
 * Fetch the world model + views for a capability and write `.agent/world-model/`.
 *
 * Best-effort throughout: an unreachable agent-runtime, a capability with no
 * views, or an unwritable workspace all return a reason instead of raising.
 */
export async function exportWorldModelToWorkspace(args: {
  agentRuntimeUrl: string;
  capabilityId: string;
  workspaceRoot: string;
}): Promise<ExportResult> {
  const { agentRuntimeUrl, capabilityId, workspaceRoot } = args;
  const empty: ExportResult = { exported: false, files: 0, views: 0 };
  if (!agentRuntimeUrl || !capabilityId || !workspaceRoot) {
    return { ...empty, reason: "missing agentRuntimeUrl, capabilityId or workspaceRoot" };
  }
  if (!fs.existsSync(workspaceRoot)) return { ...empty, reason: "workspace root does not exist" };

  const base = `${agentRuntimeUrl.replace(/\/+$/, "")}/capabilities/${encodeURIComponent(capabilityId)}`;
  const [worldModel, manifest] = await Promise.all([
    getJson(`${base}/world-model`),
    getJson(`${base}/world-model/views?include=content`),
  ]);

  const rawViews = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).views : null;
  const views: ExportedView[] = Array.isArray(rawViews)
    ? (rawViews as ExportedView[]).filter(
        (v) => v && typeof v === "object" && v.status === "READY" && typeof v.contentMd === "string" && v.contentMd.trim(),
      )
    : [];

  // Nothing to write is a normal outcome, not a failure: most capabilities have
  // no views until an operator builds them.
  if (!worldModel && views.length === 0) {
    return { ...empty, reason: "no world model or views for this capability" };
  }

  try {
    const target = path.join(workspaceRoot, WORLD_MODEL_DIR);
    // Replace rather than merge, so a deleted view does not linger as a stale
    // file that reads as current.
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });

    let files = 0;

    if (worldModel) {
      writeFile(workspaceRoot, path.join(WORLD_MODEL_DIR, "core", "model.json"), `${JSON.stringify(worldModel, null, 2)}\n`);
      files += 1;
    }

    const evidenceLines: string[] = [];
    for (const view of views) {
      writeFile(workspaceRoot, viewRelPath(view), renderViewMarkdown(view));
      files += 1;
      if (Array.isArray(view.evidence)) {
        for (const entry of view.evidence) {
          // Stamp each entry with its origin so one ledger stays traceable back
          // to the view that claimed it.
          evidenceLines.push(JSON.stringify({ viewKind: view.kind, domainKey: view.domainKey ?? "", ...(entry as object) }));
        }
      }
    }

    if (evidenceLines.length) {
      writeFile(workspaceRoot, path.join(WORLD_MODEL_DIR, "evidence", "evidence.jsonl"), `${evidenceLines.join("\n")}\n`);
      files += 1;
    }

    const manifestDoc = {
      capabilityId,
      exportedAt: new Date().toISOString(),
      repoFingerprint:
        manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).repoFingerprint ?? null : null,
      hasWorldModel: !!worldModel,
      views: views.map((v) => ({
        kind: v.kind,
        domainKey: v.domainKey ?? "",
        title: v.title,
        path: viewRelPath(v).replace(/\\/g, "/"),
        stale: !!v.stale,
        tokenEstimate: v.tokenEstimate ?? null,
        contentHash: v.contentHash ?? null,
        sourceCommit: v.sourceCommit ?? null,
      })),
    };
    writeFile(workspaceRoot, path.join(WORLD_MODEL_DIR, "manifest.json"), `${JSON.stringify(manifestDoc, null, 2)}\n`);
    files += 1;

    writeFile(
      workspaceRoot,
      path.join(AGENT_DIR, "README.md"),
      [
        "# .agent",
        "",
        "Generated capability grounding, written here by the platform on every re-ground.",
        "It is NOT part of the repository — it is excluded via `.git/info/exclude`, and",
        "any edit will be overwritten the next time the workspace is grounded.",
        "",
        "`world-model/manifest.json` lists every exported view and whether it is stale.",
        "",
      ].join("\n"),
    );
    files += 1;

    excludeAgentDirFromGit(workspaceRoot);
    return { exported: true, files, views: views.length };
  } catch (err) {
    return { ...empty, reason: `write failed: ${(err as Error).message}` };
  }
}
