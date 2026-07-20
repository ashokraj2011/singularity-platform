/**
 * Layered world-model view builder — the I/O layer over the pure core.
 *
 * Operator-triggered only: nothing here runs during onboarding or lazily on a
 * read. A capability simply has no view rows until someone asks for them, and
 * every consumer degrades to today's behaviour. That is deliberate — each view is
 * an LLM call, and silently spending tokens on views nobody loads is the failure
 * mode this design exists to avoid.
 *
 * Gateway access mirrors enrichWorldModelViaLLM (bootstrap-phase3-distill): the
 * single tagged llm-gateway, model_alias, temperature 0, hard timeout. This is an
 * INFRASTRUCTURE call, not an agent turn, so by policy it is exempt from
 * prompt-composer/context-fabric but bound to the gateway — see the entry for
 * this file in bin/check-llm-gateway-single-source.sh.
 */

import { Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors";
import { readUpstreamJsonObject } from "../../shared/upstream-json";
import { getWorldModel, getChildWorldModels } from "./world-model.service";
import {
  projectViewDoc,
  requiresDomainKey,
  type WorldModelViewDoc,
  type WorldModelViewKind,
} from "./world-model-views.types";
import { viewSpec, selectorsFor, type GroundingSelector, type ViewSpec } from "./world-model-view-specs";
import { buildViewMessages, type GroundingPack } from "./world-model-view-prompts";
import { parseViewResponse } from "./world-model-view-parser";

const VIEWS_MODEL_ALIAS = (
  process.env.WORLD_MODEL_VIEWS_MODEL_ALIAS ??
  process.env.WORLD_MODEL_DISTILL_MODEL_ALIAS ??
  ""
).trim();
const LLM_GATEWAY_URL = (process.env.LLM_GATEWAY_URL ?? "http://localhost:8001").replace(/\/+$/, "");
const VIEW_TIMEOUT_MS = 90_000;
const VIEW_MAX_OUTPUT_TOKENS = 6_000;
const MAX_SYMBOL_ROWS = 2_000;
const MAX_ARTIFACTS = 20;
const ARTIFACT_CONTENT_CAP = 4_000;

/** True when view distillation is configured. Unlike the core README distillation
 *  there is NO heuristic fallback — a role view without an LLM is not worth writing. */
export function viewBuildEnabled(): boolean {
  return VIEWS_MODEL_ALIAS.length > 0;
}

/** Repo-backed test — mirrors the filter triggerCentralCodeGrounding uses. A
 *  bootstrap-synthesised `local://` row is not a real repository. */
function isRealRepo(repo: { repoUrl: string | null; repositoryType: string | null }): boolean {
  if (!repo.repoUrl) return false;
  if (repo.repoUrl.startsWith("local://")) return false;
  return repo.repositoryType !== "LOCAL";
}

export type GroundingResult = {
  pack: GroundingPack;
  repoBacked: boolean;
  repoFingerprint: string | null;
  sourceCommit: string | null;
};

function section(selector: GroundingSelector, heading: string, body: string) {
  return { selector, heading, body };
}

/**
 * Assemble everything a view may be grounded in. Selectors the capability cannot
 * satisfy are simply absent — a capability with no repository yields no code
 * symbols, and its views are told to cite artifacts instead of file lines.
 */
export async function gatherGrounding(
  capabilityId: string,
  spec: ViewSpec,
  focus?: { kind: "domain" | "task_guide"; key: string; description?: string },
): Promise<GroundingResult> {
  const capability = await prisma.capability.findUnique({
    where: { id: capabilityId },
    select: {
      id: true,
      name: true,
      description: true,
      capabilityType: true,
      criticality: true,
      parentCapabilityId: true,
      repositories: { select: { repoUrl: true, repositoryType: true, repoName: true, defaultBranch: true, lastPolledSha: true } },
    },
  });
  if (!capability) throw new NotFoundError("Capability not found");

  const realRepos = capability.repositories.filter(isRealRepo);
  const repoBacked = realRepos.length > 0;
  const selectors = new Set(selectorsFor(spec, { repoBacked }));

  const worldModel = await getWorldModel(capabilityId);
  const sections: GroundingPack["sections"] = [];

  if (selectors.has("capability")) {
    sections.push(
      section(
        "capability",
        "Capability",
        [
          `Type: ${capability.capabilityType ?? "unspecified"}`,
          `Criticality: ${capability.criticality ?? "unspecified"}`,
          repoBacked
            ? `Repositories: ${realRepos.map((r) => `${r.repoName} (${r.repoUrl}${r.defaultBranch ? `@${r.defaultBranch}` : ""})`).join(", ")}`
            : "Repositories: none — this capability has no source repository.",
        ].join("\n"),
      ),
    );
  }

  if (selectors.has("worldModel") && worldModel) {
    const cmds = (label: string, list: Array<{ kind?: string; cmd?: string }> | undefined) =>
      list && list.length ? `${label}: ${list.map((c) => `${c.kind ?? "run"}=\`${c.cmd ?? ""}\``).join(", ")}` : null;
    sections.push(
      section(
        "worldModel",
        "World model facts",
        [
          worldModel.primaryLanguage ? `Primary language: ${worldModel.primaryLanguage}` : null,
          worldModel.buildSystem ? `Build system: ${worldModel.buildSystem}` : null,
          cmds("Build commands", worldModel.buildCommands),
          cmds("Test commands", worldModel.testCommands),
          cmds("Run commands", worldModel.runCommands),
          worldModel.readmeSummary ? `README summary:\n${worldModel.readmeSummary}` : null,
          worldModel.codeConventions?.length
            ? `Known conventions:\n${worldModel.codeConventions.map((c) => `- ${c.topic}: ${c.rule}`).join("\n")}`
            : null,
          worldModel.entrypoints?.length
            ? `Known entrypoints:\n${worldModel.entrypoints.map((e) => `- ${e.kind}: ${e.target}`).join("\n")}`
            : null,
          worldModel.knownFailures?.length
            ? `Known failures:\n${worldModel.knownFailures.map((f) => `- ${f.test}${f.reason ? `: ${f.reason}` : ""}`).join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  if (selectors.has("architectureSlice") && worldModel?.architectureSlice) {
    const roots = worldModel.architectureSlice.rootPackages ?? [];
    if (roots.length) {
      sections.push(
        section(
          "architectureSlice",
          "Package map",
          roots
            .map((p) => `- ${p.path}${p.language ? ` (${p.language})` : ""}${p.publicSymbols?.length ? `: ${p.publicSymbols.slice(0, 12).join(", ")}` : ""}`)
            .join("\n"),
        ),
      );
    }
  }

  if (selectors.has("agentRules") && worldModel?.agentRules?.length) {
    sections.push(
      section("agentRules", "Repository agent rules (verbatim)", worldModel.agentRules.map((r) => `### ${r.source}\n${r.content}`).join("\n\n")),
    );
  }

  // Code symbols are what make file:line evidence possible at all.
  if (selectors.has("codeSymbols")) {
    const symbols = await prisma.capabilityCodeSymbol.findMany({
      where: { capabilityId },
      select: { filePath: true, symbolName: true, symbolType: true, startLine: true, endLine: true, summary: true },
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
      take: MAX_SYMBOL_ROWS,
    });
    if (symbols.length) {
      sections.push(
        section(
          "codeSymbols",
          `Code symbols (${symbols.length}${symbols.length === MAX_SYMBOL_ROWS ? ", capped" : ""}) — cite these for file:line evidence`,
          symbols
            .map((s) => `${s.filePath}${s.startLine ? `:${s.startLine}${s.endLine ? `-${s.endLine}` : ""}` : ""} ${s.symbolType ?? ""} ${s.symbolName ?? ""}${s.summary ? ` — ${s.summary}` : ""}`.trim())
            .join("\n"),
        ),
      );
    }
  }

  if (selectors.has("knowledgeArtifacts")) {
    const artifacts = await prisma.capabilityKnowledgeArtifact.findMany({
      where: { capabilityId, status: "ACTIVE" },
      select: { id: true, title: true, artifactType: true, content: true },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: MAX_ARTIFACTS,
    });
    if (artifacts.length) {
      sections.push(
        section(
          "knowledgeArtifacts",
          "Knowledge artifacts — cite by artifactId",
          artifacts
            .map((a) => `### artifactId=${a.id} · ${a.title} (${a.artifactType})\n${a.content.slice(0, ARTIFACT_CONTENT_CAP)}`)
            .join("\n\n"),
        ),
      );
    }
  }

  if (selectors.has("childWorldModels")) {
    const children = await getChildWorldModels(capabilityId);
    if (children.length) {
      sections.push(
        section(
          "childWorldModels",
          "Child capabilities",
          children
            .map((c) => `- ${c.name} (${c.capabilityId})${c.primaryLanguage ? ` — ${c.primaryLanguage}` : ""}${c.readmeSummary ? `: ${c.readmeSummary}` : ""}`)
            .join("\n"),
        ),
      );
    }
  }

  return {
    pack: {
      capabilityName: capability.name,
      capabilityDescription: capability.description ?? null,
      repoBacked,
      sections,
      ...(focus ? { focus } : {}),
    },
    repoBacked,
    repoFingerprint: worldModel?.repoFingerprint ?? null,
    sourceCommit: realRepos.find((r) => r.lastPolledSha)?.lastPolledSha ?? null,
  };
}

/** One gateway turn for one view. Returns raw content, or null on any failure. */
async function callGateway(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  try {
    const res = await fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_alias: VIEWS_MODEL_ALIAS,
        messages,
        temperature: 0,
        max_output_tokens: VIEW_MAX_OUTPUT_TOKENS,
        // Infrastructure work, not an agent turn: composer/CF-exempt by policy,
        // but tagged so its spend is attributable at the gateway.
        task_tag: "world_model_distill",
        purpose: "world_model_view",
        // Tagged since W2-1, but anonymous until now. View builds are triggered
        // by capability changes, not by a person waiting on a result.
        actor_id: "system:agent-runtime",
        // No tenant_id: views are scoped by capability; Capability carries no
        // tenant column on this branch.
      }),
      signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await readUpstreamJsonObject(res, "LLM gateway world-model view")) as { content?: string };
    return body.content ?? null;
  } catch {
    return null;
  }
}

async function assertCapabilityWritable(capabilityId: string): Promise<void> {
  const capability = await prisma.capability.findUnique({ where: { id: capabilityId }, select: { status: true } });
  if (!capability) throw new NotFoundError("Capability not found");
  if (capability.status === "ARCHIVED") {
    throw new ForbiddenError("Capability is archived; world-model maintenance is read-only.");
  }
}

export type ViewBuildRequest = { kind: WorldModelViewKind; domainKey?: string; description?: string };
export type ViewBuildOutcome = { kind: WorldModelViewKind; domainKey: string; status: "READY" | "FAILED"; warnings: string[]; error?: string };

// One build per capability at a time. Views share grounding queries and the
// gateway; concurrent builds would duplicate both and race the same rows.
const inflight = new Map<string, Promise<ViewBuildOutcome[]>>();

async function buildOne(capabilityId: string, req: ViewBuildRequest): Promise<ViewBuildOutcome> {
  const spec = viewSpec(req.kind);
  const domainKey = requiresDomainKey(req.kind) ? (req.domainKey ?? "").trim() : "";
  const where = { capabilityId_kind_domainKey: { capabilityId, kind: req.kind, domainKey } };

  const focus = requiresDomainKey(req.kind)
    ? ({ kind: req.kind as "domain" | "task_guide", key: domainKey, description: req.description } as const)
    : undefined;

  const seed = {
    capabilityId,
    kind: req.kind,
    domainKey,
    title: spec.title,
    contentMd: "",
    evidence: [] as unknown as Prisma.InputJsonValue,
    status: "BUILDING",
    buildError: null,
    generatedBy: VIEWS_MODEL_ALIAS,
  };
  await prisma.capabilityWorldModelViewDoc.upsert({
    where,
    create: seed,
    update: { status: "BUILDING", buildError: null, generatedBy: VIEWS_MODEL_ALIAS },
  });

  const fail = async (error: string): Promise<ViewBuildOutcome> => {
    await prisma.capabilityWorldModelViewDoc.update({ where, data: { status: "FAILED", buildError: error.slice(0, 1000) } });
    return { kind: req.kind, domainKey, status: "FAILED", warnings: [], error };
  };

  let grounding: GroundingResult;
  try {
    grounding = await gatherGrounding(capabilityId, spec, focus);
  } catch (err) {
    return fail(`grounding failed: ${(err as Error).message}`);
  }
  if (grounding.pack.sections.length === 0) {
    return fail("no grounding available for this capability — nothing to distil");
  }

  const raw = await callGateway(buildViewMessages(spec, grounding.pack));
  if (!raw) return fail("gateway call failed or returned no content");

  const parsed = parseViewResponse(raw, spec, { commit: grounding.sourceCommit });
  if (!parsed) return fail("response was not usable strict JSON with contentMd");

  await prisma.capabilityWorldModelViewDoc.update({
    where,
    data: {
      title: parsed.title,
      contentMd: parsed.contentMd,
      structured: (parsed.structured ?? undefined) as Prisma.InputJsonValue | undefined,
      evidence: parsed.evidence as unknown as Prisma.InputJsonValue,
      sourceCommit: grounding.sourceCommit,
      repoFingerprint: grounding.repoFingerprint,
      tokenEstimate: parsed.tokenEstimate,
      contentHash: parsed.contentHash,
      status: "READY",
      buildError: parsed.warnings.length ? parsed.warnings.join("; ").slice(0, 1000) : null,
      generatedBy: VIEWS_MODEL_ALIAS,
    },
  });
  return { kind: req.kind, domainKey, status: "READY", warnings: parsed.warnings };
}

const WORKSPACE_EXPORT_TIMEOUT_MS = 15_000;

/**
 * Ask mcp-server to re-export .agent/world-model/ for this capability.
 *
 * Mirrors triggerCentralCodeGrounding: same base URL, same bearer, warn-only.
 * Only meaningful for repo-backed capabilities — a capability with no repository
 * has no workspace to export into — but the check lives on the mcp-server side,
 * which knows whether a workspace exists at all.
 */
async function triggerWorkspaceExport(capabilityId: string): Promise<void> {
  const base = (process.env.MCP_SERVER_URL ?? "").replace(/\/+$/, "");
  if (!base || base === "mock") return;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.MCP_BEARER_TOKEN ?? "";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/mcp/world-model/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ capability_id: capabilityId }),
      signal: AbortSignal.timeout(WORKSPACE_EXPORT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[world-model.export] capabilityId=${capabilityId} /mcp/world-model/export HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[world-model.export] capabilityId=${capabilityId} failed: ${(err as Error).message}`);
  }
}

/**
 * Build the requested views, sequentially. Sequential is deliberate: the gateway
 * is a shared, rate-limited resource and a capability's views are not urgent.
 * One view failing does not abort the rest — each records its own FAILED row.
 */
export async function buildViews(capabilityId: string, requests: ViewBuildRequest[]): Promise<ViewBuildOutcome[]> {
  const existing = inflight.get(capabilityId);
  if (existing) return existing;

  if (!viewBuildEnabled()) {
    throw new ValidationError("World-model view distillation is not configured (set WORLD_MODEL_VIEWS_MODEL_ALIAS).");
  }

  // The slot is claimed with no await between the check and the set. Awaiting
  // first — on the archive guard, say — lets two concurrent builds both find the
  // map empty, and they would then race each other's upserts on the same rows
  // while paying twice at the gateway. The guard moves inside the run instead.
  const run = (async () => {
    await assertCapabilityWritable(capabilityId);
    const outcomes: ViewBuildOutcome[] = [];
    for (const req of requests) {
      outcomes.push(await buildOne(capabilityId, req));
    }
    // Push the new views into the central workspace's .agent/world-model/ so
    // filesystem-bound agents see them without waiting for the next re-ground.
    // Fire-and-forget and warn-only: the views are already committed to the DB,
    // which is the system of record, so a failed export costs a stale file copy
    // and nothing more.
    if (outcomes.some((o) => o.status === "READY")) {
      void triggerWorkspaceExport(capabilityId);
    }
    return outcomes;
  })();

  inflight.set(capabilityId, run);
  try {
    return await run;
  } finally {
    inflight.delete(capabilityId);
  }
}

export function isBuildInFlight(capabilityId: string): boolean {
  return inflight.has(capabilityId);
}

/** All view rows for a capability, newest-relevant first. */
export async function listViews(capabilityId: string): Promise<WorldModelViewDoc[]> {
  const rows = await prisma.capabilityWorldModelViewDoc.findMany({
    where: { capabilityId },
    orderBy: [{ kind: "asc" }, { domainKey: "asc" }],
  });
  return rows.map(projectViewDoc);
}

export async function getView(capabilityId: string, kind: WorldModelViewKind, domainKey = ""): Promise<WorldModelViewDoc | null> {
  const row = await prisma.capabilityWorldModelViewDoc.findUnique({
    where: { capabilityId_kind_domainKey: { capabilityId, kind, domainKey } },
  });
  return row ? projectViewDoc(row) : null;
}

export async function deleteView(capabilityId: string, kind: WorldModelViewKind, domainKey = ""): Promise<boolean> {
  await assertCapabilityWritable(capabilityId);
  const res = await prisma.capabilityWorldModelViewDoc.deleteMany({ where: { capabilityId, kind, domainKey } });
  return res.count > 0;
}
