/**
 * M17 — polling worker.
 *
 * Two responsibilities, one in-process loop:
 *   1. CapabilityRepository.pollIntervalSec — clone or pull the repo, walk
 *      every source file, call extractRepositorySymbols() if HEAD SHA changed.
 *      **Disabled by default post-M27.** Code symbols now live wherever
 *      mcp-server runs (laptop, VPC, dev server) inside its local AST
 *      index; the agent fetches them via `find_symbol`/`get_symbol` tools
 *      instead of relying on a server-side mirror. Flip
 *      POLL_REPOSITORIES_ENABLED=true to bring the clone loop back for
 *      tenants that haven't migrated. The symbol-write path is gated
 *      independently by EXTRACTOR_MODE (default `off`).
 *   2. CapabilityKnowledgeSource.pollIntervalSec — fetch the URL, compare
 *      sha256 hash to lastContentHash, addKnowledge() if changed. **Always
 *      enabled** — this path produces KnowledgeArtifact rows that the
 *      composer reads at compose-time and is unrelated to the code-symbol
 *      pipeline.
 *
 * Single setInterval loop ticks every TICK_SEC and processes any row whose
 * `lastPolledAt + pollIntervalSec` is in the past. Errors stamp
 * lastPollError so the SPA can surface them; success clears it.
 *
 * Public-only HTTPS for v0 — no SSH, no token-auth. Private repos are a
 * follow-up (needs per-tenant credential storage).
 *
 * Worker is disabled when POLL_WORKER_ENABLED=0 (eg in tests).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { prisma } from "../../config/prisma";
import { capabilityService } from "./capability.service";
import type { InputFile } from "./symbol-extractor";
import { ForbiddenError } from "../../shared/errors";
import { capabilityIsArchivedOrMissing } from "./capability-lifecycle";

const execFileP = promisify(execFile);

const TICK_SEC          = Number(process.env.POLL_WORKER_TICK_SEC ?? 30);
const ENABLED           = (process.env.POLL_WORKER_ENABLED ?? "1") !== "0";
const SOURCE_EXT        = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/i;
const SKIP_DIRS         = new Set([
  "node_modules", ".git", "dist", "build", "out", "__pycache__", ".venv", "venv",
  ".next", ".turbo", ".cache", "coverage", "target",
]);
const FILE_SIZE_CAP     = 200_000;
const PAYLOAD_CAP       = 24_000_000;
const FETCH_TIMEOUT_MS  = 30_000;
const URL_CONTENT_CAP   = 5_000_000;

let timer: NodeJS.Timeout | null = null;
let isTicking = false;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[poll-worker] ${msg}`);
}

async function assertCapabilityPollable(capabilityId: string, action: string): Promise<void> {
  if (await capabilityIsArchivedOrMissing(capabilityId)) {
    throw new ForbiddenError(`Cannot ${action} for an archived capability.`);
  }
}

export function startPollWorker(): void {
  if (!ENABLED) {
    log("disabled (POLL_WORKER_ENABLED=0)");
    return;
  }
  if (timer) return;
  log(`starting; tick=${TICK_SEC}s`);
  timer = setInterval(() => { void tick(); }, TICK_SEC * 1000);
  // First tick after a short delay so the server is fully up.
  setTimeout(() => { void tick(); }, 5_000);
}

export function stopPollWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(): Promise<void> {
  if (isTicking) return; // prevent overlap on a slow tick
  isTicking = true;
  try {
    await Promise.allSettled([pollRepositories(), pollKnowledgeSources()]);
  } finally {
    isTicking = false;
  }
}

// ── Repositories ────────────────────────────────────────────────────────────

// M25.7 #3 — opt-in. Code symbols moved to mcp-server's local AST index
// (M27) — wherever mcp-server runs. The platform-side clone/fetch loop
// produces no useful work in that world, just CPU + disk churn. Flip
// POLL_REPOSITORIES_ENABLED=true to restore the legacy path. Note that
// EXTRACTOR_MODE still gates the symbol writes independently.
const POLL_REPOSITORIES_ENABLED = (process.env.POLL_REPOSITORIES_ENABLED ?? "false").toLowerCase() === "true";
let warnedRepoPollDisabled = false;

async function pollRepositories(): Promise<void> {
  if (!POLL_REPOSITORIES_ENABLED) {
    if (!warnedRepoPollDisabled) {
      log("repository polling disabled (POLL_REPOSITORIES_ENABLED=false); set to 'true' to restore the M17 clone loop");
      warnedRepoPollDisabled = true;
    }
    return;
  }
  const due = await prisma.$queryRawUnsafe<Array<{
    id: string; capabilityId: string; repoName: string; repoUrl: string;
    defaultBranch: string | null; lastPolledSha: string | null;
  }>>(`
    SELECT r.id, r."capabilityId", r."repoName", r."repoUrl", r."defaultBranch", r."lastPolledSha"
    FROM "CapabilityRepository" r
    JOIN "Capability" c ON c.id = r."capabilityId"
    WHERE r."pollIntervalSec" IS NOT NULL
      AND r.status = 'ACTIVE'
      AND c.status <> 'ARCHIVED'
      AND (r."lastPolledAt" IS NULL
           OR r."lastPolledAt" + (r."pollIntervalSec" * INTERVAL '1 second') < now())
    ORDER BY COALESCE(r."lastPolledAt", to_timestamp(0)) ASC
    LIMIT 5
  `);
  for (const r of due) {
    try {
      const result = await pollOneRepo(r);
      if (result.skippedArchived) continue;
      await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityRepository"
         SET "lastPolledAt" = now(),
             "lastPolledSha" = $1,
             "lastPollError" = NULL
         WHERE id = $2
           AND status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM "Capability" c
             WHERE c.id = "CapabilityRepository"."capabilityId"
               AND c.status <> 'ARCHIVED'
           )`,
        result.headSha, r.id,
      );
      if (result.extracted) log(`repo ${r.repoName}: extracted (sha ${result.headSha.slice(0,7)})`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityRepository"
         SET "lastPolledAt" = now(), "lastPollError" = $1
         WHERE id = $2
           AND status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM "Capability" c
             WHERE c.id = "CapabilityRepository"."capabilityId"
               AND c.status <> 'ARCHIVED'
           )`,
        msg, r.id,
      );
      log(`repo ${r.repoName}: error ${msg}`);
    }
  }
}

export async function syncRepositoryNow(
  capabilityId: string,
  repoId: string,
): Promise<{ repoId: string; repoName: string; headSha: string; extracted: boolean }> {
  await assertCapabilityPollable(capabilityId, "sync repository sources");
  const repo = await prisma.capabilityRepository.findFirst({
    where: { id: repoId, capabilityId },
  });
  if (!repo) throw new Error("repository not found for capability");
  if (repo.repositoryType === "LOCAL" || repo.repoUrl.startsWith("local://")) {
    throw new Error("local repository sync requires an approved local directory upload");
  }
  if (repo.status !== "ACTIVE") throw new Error(`repository is ${repo.status}`);

  try {
    const result = await pollOneRepo({
      id: repo.id,
      capabilityId: repo.capabilityId,
      repoName: repo.repoName,
      repoUrl: repo.repoUrl,
      defaultBranch: repo.defaultBranch,
      lastPolledSha: repo.lastPolledSha,
    });
    if (result.skippedArchived) throw new ForbiddenError("Cannot sync repository sources for an archived capability.");
    await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityRepository"
       SET "lastPolledAt" = now(),
           "lastPolledSha" = $1,
           "lastPollError" = NULL
       WHERE id = $2
         AND status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM "Capability" c
           WHERE c.id = "CapabilityRepository"."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      result.headSha,
      repo.id,
    );
    return {
      repoId: repo.id,
      repoName: repo.repoName,
      headSha: result.headSha,
      extracted: result.extracted,
    };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityRepository"
       SET "lastPolledAt" = now(), "lastPollError" = $1
       WHERE id = $2
         AND status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM "Capability" c
           WHERE c.id = "CapabilityRepository"."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      msg,
      repo.id,
    );
    throw err;
  }
}

async function pollOneRepo(r: {
  id: string; capabilityId: string; repoName: string; repoUrl: string;
  defaultBranch: string | null; lastPolledSha: string | null;
}): Promise<{ headSha: string; extracted: boolean; skippedArchived?: boolean }> {
  if (await capabilityIsArchivedOrMissing(r.capabilityId)) {
    return { headSha: r.lastPolledSha ?? "", extracted: false, skippedArchived: true };
  }
  // Use a per-repo cache dir so successive polls reuse the local clone.
  const baseDir = process.env.POLL_WORKER_CACHE_DIR ?? path.join(os.tmpdir(), "agent-runtime-polls");
  const repoDir = path.join(baseDir, r.id);
  await fs.promises.mkdir(baseDir, { recursive: true });

  const branch = r.defaultBranch ?? "main";
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    // Fresh shallow clone
    await execFileP("git", ["clone", "--depth", "1", "--branch", branch, r.repoUrl, repoDir], {
      timeout: 60_000,
    }).catch(async () => {
      // Some repos default to `master`; retry without --branch.
      await fs.promises.rm(repoDir, { recursive: true, force: true });
      await execFileP("git", ["clone", "--depth", "1", r.repoUrl, repoDir], { timeout: 60_000 });
    });
  } else {
    await execFileP("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", branch], {
      timeout: 60_000,
    }).catch(() => execFileP("git", ["-C", repoDir, "fetch", "--depth", "1"], { timeout: 60_000 }));
    await execFileP("git", ["-C", repoDir, "reset", "--hard", `origin/${branch}`], {
      timeout: 30_000,
    }).catch(async () => {
      // Fall back to whatever HEAD origin points at.
      await execFileP("git", ["-C", repoDir, "reset", "--hard", "FETCH_HEAD"], { timeout: 30_000 });
    });
  }

  const { stdout: shaRaw } = await execFileP("git", ["-C", repoDir, "rev-parse", "HEAD"]);
  const headSha = shaRaw.trim();
  if (headSha === r.lastPolledSha) return { headSha, extracted: false };

  // M25.7 / M27 — when EXTRACTOR_MODE=off the platform-side symbol mirror is
  // disabled (code symbols moved per-laptop). Walking + indexing on every
  // poll wastes CPU; skip cleanly. Polling continues to track HEAD SHA so
  // when an operator re-enables the extractor it picks up where it left off.
  if ((process.env.EXTRACTOR_MODE ?? "off").toLowerCase() === "off") {
    return { headSha, extracted: false };
  }

  const files: InputFile[] = [];
  let bytes = 0;
  await walkSourceFiles(repoDir, repoDir, files, () => bytes, (n) => bytes = n);
  if (files.length === 0) return { headSha, extracted: false };

  await capabilityService.extractRepositorySymbols(r.capabilityId, r.id, files);
  return { headSha, extracted: true };
}

async function walkSourceFiles(
  root: string, dir: string, out: InputFile[],
  getBytes: () => number, setBytes: (n: number) => void,
): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkSourceFiles(root, full, out, getBytes, setBytes);
      continue;
    }
    if (!e.isFile() || !SOURCE_EXT.test(e.name)) continue;
    const stat = await fs.promises.stat(full);
    if (stat.size > FILE_SIZE_CAP) continue;
    if (getBytes() + stat.size > PAYLOAD_CAP) return; // hard cap; trim trailing files
    const content = await fs.promises.readFile(full, "utf8");
    out.push({ path: path.relative(root, full), content });
    setBytes(getBytes() + content.length);
  }
}

// ── Knowledge sources ───────────────────────────────────────────────────────

async function pollKnowledgeSources(): Promise<void> {
  const due = await prisma.$queryRawUnsafe<Array<{
    id: string; capabilityId: string; url: string; artifactType: string;
    title: string | null; lastContentHash: string | null;
  }>>(`
    SELECT s.id, s."capabilityId", s.url, s."artifactType", s.title, s."lastContentHash"
    FROM "CapabilityKnowledgeSource" s
    JOIN "Capability" c ON c.id = s."capabilityId"
    WHERE s."pollIntervalSec" IS NOT NULL
      AND s.status = 'ACTIVE'
      AND c.status <> 'ARCHIVED'
      AND (s."lastPolledAt" IS NULL
           OR s."lastPolledAt" + (s."pollIntervalSec" * INTERVAL '1 second') < now())
    ORDER BY COALESCE(s."lastPolledAt", to_timestamp(0)) ASC
    LIMIT 10
  `);
  for (const s of due) {
    try {
      const result = await pollOneSource(s);
      if (result.skippedArchived) continue;
      await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityKnowledgeSource"
         SET "lastPolledAt" = now(),
             "lastContentHash" = $1,
             "lastPollError" = NULL
         WHERE id = $2
           AND status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM "Capability" c
             WHERE c.id = "CapabilityKnowledgeSource"."capabilityId"
               AND c.status <> 'ARCHIVED'
           )`,
        result.contentHash, s.id,
      );
      if (result.upserted) log(`knowledge ${s.url}: upserted (hash ${result.contentHash.slice(0,8)})`);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await prisma.$executeRawUnsafe(
        `UPDATE "CapabilityKnowledgeSource"
         SET "lastPolledAt" = now(), "lastPollError" = $1
         WHERE id = $2
           AND status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM "Capability" c
             WHERE c.id = "CapabilityKnowledgeSource"."capabilityId"
               AND c.status <> 'ARCHIVED'
           )`,
        msg, s.id,
      );
      log(`knowledge ${s.url}: error ${msg}`);
    }
  }
}

export async function syncKnowledgeSourceNow(
  capabilityId: string,
  sourceId: string,
): Promise<{ sourceId: string; url: string; contentHash: string; upserted: boolean }> {
  await assertCapabilityPollable(capabilityId, "sync knowledge sources");
  const source = await prisma.capabilityKnowledgeSource.findFirst({
    where: { id: sourceId, capabilityId },
  });
  if (!source) throw new Error("knowledge source not found for capability");
  if (source.status !== "ACTIVE") throw new Error(`knowledge source is ${source.status}`);

  try {
    const result = await pollOneSource({
      id: source.id,
      capabilityId: source.capabilityId,
      url: source.url,
      artifactType: source.artifactType,
      title: source.title,
      lastContentHash: source.lastContentHash,
    });
    if (result.skippedArchived) throw new ForbiddenError("Cannot sync knowledge sources for an archived capability.");
    await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityKnowledgeSource"
       SET "lastPolledAt" = now(),
           "lastContentHash" = $1,
           "lastPollError" = NULL
       WHERE id = $2
         AND status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM "Capability" c
           WHERE c.id = "CapabilityKnowledgeSource"."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      result.contentHash,
      source.id,
    );
    return {
      sourceId: source.id,
      url: source.url,
      contentHash: result.contentHash,
      upserted: result.upserted,
    };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityKnowledgeSource"
       SET "lastPolledAt" = now(), "lastPollError" = $1
       WHERE id = $2
         AND status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM "Capability" c
           WHERE c.id = "CapabilityKnowledgeSource"."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      msg,
      source.id,
    );
    throw err;
  }
}

async function pollOneSource(s: {
  id: string; capabilityId: string; url: string; artifactType: string;
  title: string | null; lastContentHash: string | null;
}): Promise<{ contentHash: string; upserted: boolean; skippedArchived?: boolean }> {
  if (await capabilityIsArchivedOrMissing(s.capabilityId)) {
    return { contentHash: s.lastContentHash ?? "", upserted: false, skippedArchived: true };
  }
  const res = await fetch(s.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.text()).slice(0, URL_CONTENT_CAP);
  const contentHash = createHash("sha256").update(text).digest("hex");
  if (contentHash === s.lastContentHash) return { contentHash, upserted: false };

  const title = s.title?.trim() || s.url;
  // Idempotent on the source-backed artifact identity. Do not archive first:
  // if the process dies before lastContentHash is saved, the retry must reuse
  // the same active artifact instead of creating a duplicate history row.
  await capabilityService.addKnowledge(s.capabilityId, {
    artifactType: s.artifactType,
    title,
    content: text,
    sourceType: "URL_POLL",
    sourceRef: s.url,
    confidence: 0.9,
  });
  return { contentHash, upserted: true };
}
