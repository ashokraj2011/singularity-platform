import { Request, Response } from "express";
import { capabilityService } from "./capability.service";
import { syncKnowledgeSourceNow, syncRepositoryNow } from "./poll-worker";
import { ok } from "../../shared/response";
// Tenant entitlement gate for capability-scoped READS. Mirrors the memory list
// reads: 403s a capabilityId outside the caller's scope in a tenant-scoped
// deploy so these routes can't read another tenant's grounding by UUID (IDOR).
import { assertCapabilityReadScope } from "../memory/memory.tenant-scope";
// M61 Slice E — repo-fingerprint drift detection. Exposed as a thin
// REST endpoint so any caller with a workspace on disk (mcp-server,
// workgraph-api, an operator script) can submit a fingerprint without
// pulling in the world-model.service or Prisma client.
import { worldModelDriftService } from "./world-model-drift.service";
// M61 Wire B P2 — AST index callback writes astIndexedAt + astIndexFiles
// to the world-model row when mcp-server reports the index is built.
// M61 Wire 1 — getWorldModel powers the new GET reader endpoint that
// context-fabric calls at workflow start.
import { upsertWorldModel, getWorldModel, getChildWorldModels } from "./world-model.service";
import { distillAndUpsertWorldModel } from "./bootstrap-phase3-distill";
import { buildViews, listViews, getView, deleteView, viewBuildEnabled, isBuildInFlight } from "./world-model-view-builder.service";
import { planViewBuild, allViewSpecs, loadViewSpecsWithMeta } from "./world-model-view-specs";
import { getWorldModelSlice } from "./world-model-slice.service";
import { isWorldModelViewKind, isViewStale } from "./world-model-views.types";
// M61 Wire D — Verify-now command probe powering the wizard's per-row
// "Verify" button. Spawns the cmd in an isolated tmp dir with a 10s
// timeout; returns exit code + capped stdout/stderr.
import { probeCommand } from "./command-probe.service";
import { extractKnowledgeText } from "./document-extract";
import { findDuplicateKnowledgeUploadName } from "./capability-upload-identity";
import { ConflictError, ForbiddenError } from "../../shared/errors";

async function assertCapabilityMutable(
  capabilityId: string,
  message = "Capability is archived and cannot be modified.",
): Promise<void> {
  const capability = await capabilityService.get(capabilityId);
  if (String(capability.status ?? "").toUpperCase() === "ARCHIVED") {
    throw new ForbiddenError(message);
  }
}

export const capabilityController = {
  async bootstrapAgentCatalog(_req: Request, res: Response) {
    return ok(res, capabilityService.bootstrapAgentCatalog());
  },
  async create(req: Request, res: Response) {
    return ok(res, await capabilityService.create(req.body, req.headers.authorization), 201);
  },
  async bootstrap(req: Request, res: Response) {
    return ok(res, await capabilityService.bootstrap(req.body, req.user?.user_id, req.headers.authorization), 201);
  },
  async list(req: Request, res: Response) {
    const includeArchived = String(req.query.includeArchived ?? "").toLowerCase() === "true";
    return ok(res, await capabilityService.list({ includeArchived }));
  },
  async get(req: Request, res: Response) {
    return ok(res, await capabilityService.get(req.params.id));
  },
  async readiness(req: Request, res: Response) {
    return ok(res, await capabilityService.readiness(req.params.id));
  },
  async groundingStatus(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    return ok(res, await capabilityService.groundingStatus(req.params.id));
  },
  async architectureDiagram(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    return ok(res, await capabilityService.architectureDiagram(req.params.id));
  },
  async update(req: Request, res: Response) {
    return ok(res, await capabilityService.update(req.params.id, req.body, req.headers.authorization));
  },
  async archive(req: Request, res: Response) {
    return ok(res, await capabilityService.archive(req.params.id, req.user?.user_id, req.headers.authorization));
  },
  async getBootstrapRun(req: Request, res: Response) {
    return ok(res, await capabilityService.getBootstrapRun(req.params.id, req.params.runId));
  },
  async reviewBootstrapRun(req: Request, res: Response) {
    return ok(
      res,
      await capabilityService.reviewBootstrapRun(req.params.id, req.params.runId, req.body, req.user?.user_id),
    );
  },
  async sync(req: Request, res: Response) {
    return ok(
      res,
      await capabilityService.syncCapability(req.params.id, req.body, {
        syncRepository: syncRepositoryNow,
        syncKnowledgeSource: syncKnowledgeSourceNow,
      }),
    );
  },
  async runLearningWorker(req: Request, res: Response) {
    return ok(
      res,
      await capabilityService.runLearningWorker(req.params.id, req.body, {
        syncRepository: syncRepositoryNow,
        syncKnowledgeSource: syncKnowledgeSourceNow,
      }, req.user?.user_id),
    );
  },
  // GET /capabilities/:id/repositories — all linked repos (any status), ACTIVE
  // first. Unlike GET /:id (ACTIVE-filtered), this lets callers resolve a repo
  // URL even while indexing is still in progress.
  async listRepositories(req: Request, res: Response) {
    return ok(res, await capabilityService.listRepositories(req.params.id));
  },
  async attachRepo(req: Request, res: Response) {
    return ok(res, await capabilityService.attachRepository(req.params.id, req.body), 201);
  },
  async deleteRepo(req: Request, res: Response) {
    return ok(res, await capabilityService.deleteRepository(req.params.id, req.params.repoId));
  },
  async bindAgent(req: Request, res: Response) {
    return ok(res, await capabilityService.bindAgent(req.params.id, req.body, req.user?.user_id), 201);
  },
  async listBindings(req: Request, res: Response) {
    return ok(res, await capabilityService.listBindings(req.params.id));
  },
  async deleteBinding(req: Request, res: Response) {
    return ok(res, await capabilityService.deleteBinding(req.params.id, req.params.bindingId));
  },
  async addKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.addKnowledge(req.params.id, req.body), 201);
  },
  async listKnowledge(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    const includeArchived = String(req.query.includeArchived ?? "").toLowerCase() === "true";
    return ok(res, await capabilityService.listKnowledge(req.params.id, { includeArchived }));
  },
  async deleteKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.deleteKnowledgeArtifact(req.params.id, req.params.artifactId));
  },
  async extractSymbols(req: Request, res: Response) {
    const result = await capabilityService.extractRepositorySymbols(
      req.params.id,
      req.params.repoId,
      req.body.files,
    );
    return ok(res, result, 201);
  },

  // M17 — polling config.
  async updateRepoPoll(req: Request, res: Response) {
    const updated = await capabilityService.updateRepositoryPoll(req.params.id, req.params.repoId, req.body);
    return ok(res, updated, 200);
  },
  async listKnowledgeSources(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    return ok(res, await capabilityService.listKnowledgeSources(req.params.id));
  },
  async addKnowledgeSource(req: Request, res: Response) {
    return ok(res, await capabilityService.addKnowledgeSource(req.params.id, req.body), 201);
  },
  async updateKnowledgeSource(req: Request, res: Response) {
    return ok(res, await capabilityService.updateKnowledgeSource(req.params.id, req.params.sourceId, req.body));
  },
  async deleteKnowledgeSource(req: Request, res: Response) {
    return ok(res, await capabilityService.deleteKnowledgeSource(req.params.id, req.params.sourceId));
  },

  async reembed(req: Request, res: Response) {
    const kindsParam = req.body?.kinds;
    const kinds = Array.isArray(kindsParam) ? kindsParam.filter((k: unknown): k is "knowledge" | "memory" | "code" =>
      k === "knowledge" || k === "memory" || k === "code",
    ) : undefined;
    const result = await capabilityService.reembedCapability(req.params.id, { kinds });
    return ok(res, result, 200);
  },

  // M15 — multipart upload variant. Server-side text extraction by mime;
  // delegates to addKnowledge for embedding + storage. multer attaches the
  // parsed files at `req.files` (memoryStorage; small dependency on the
  // request body size limit at the proxy in front).
  async uploadKnowledge(req: Request, res: Response) {
    const files = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
    if (files.length === 0) return res.status(400).json({ error: "no files" });
    await assertCapabilityMutable(req.params.id, "Capability is archived; knowledge upload is read-only.");
    const duplicateUploadName = findDuplicateKnowledgeUploadName(files);
    if (duplicateUploadName) {
      throw new ConflictError(
        `Uploaded knowledge filename "${duplicateUploadName}" appears more than once. Rename one file before uploading.`,
      );
    }

    const artifactType = (req.body.artifactType as string | undefined) ?? "DOC";
    const baseConf = Number(req.body.confidence ?? 0.9);
    const created: Array<Record<string, unknown>> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const f of files) {
      let content: string;
      try {
        content = await extractKnowledgeText(f);
        if (!content) {
          skipped.push({ name: f.originalname, reason: "empty-text" });
          continue;
        }
      } catch (err) {
        skipped.push({ name: f.originalname, reason: `extract failed: ${(err as Error).message}` });
        continue;
      }

      const row = await capabilityService.addKnowledge(req.params.id, {
        artifactType,
        title: f.originalname,
        content: content.slice(0, 5_000_000), // cap rows at 5MB of text
        sourceType: "FILE_UPLOAD",
        sourceRef: f.originalname,
        confidence: baseConf,
      });
      created.push(row);
    }

    return ok(res, { uploaded: created.length, skipped, items: created }, 201);
  },

  // M61 Slice E — POST /capabilities/:id/world-model/fingerprint
  //
  // Body: { fingerprint, hashedBuildFiles?, topLevelEntries? }
  // Returns: { drift: bool, previousFingerprint, currentFingerprint, firstStamp }
  //
  // The caller (mcp-server at workspace setup, workgraph-api at
  // workflow start, an operator script) computes the fingerprint
  // locally using computeRepoFingerprint and submits it here. We do
  // not require the caller to send the workspace contents — only the
  // hash — which keeps this endpoint cheap and free of file-system
  // assumptions.
  // M61 Wire 1 — GET /capabilities/:id/world-model
  //
  // Returns the projected CapabilityWorldModelView for the capability,
  // or 404 when no row exists yet (a capability that hasn't been
  // bootstrapped under M61, or one whose Phase 1 worker hasn't seeded
  // the row yet). The shape matches ComposeInput.worldModel exactly
  // so context-fabric can pass the response body through as-is.
  //
  // Read-only. Idempotent. Safe to call on every workflow start.
  async getWorldModel(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    const view = await getWorldModel(req.params.id);
    if (!view) return res.status(404).json({ error: "world model not yet generated for this capability" });
    // For a parent / delivery capability, embed its children's world models BY
    // REFERENCE — fetched on demand from the local hierarchy, never stored on the
    // parent. Empty for leaf capabilities.
    const childWorldModels = await getChildWorldModels(req.params.id);
    return ok(res, childWorldModels.length > 0 ? { ...view, childWorldModels } : view, 200);
  },

  // ── Layered world-model views ──────────────────────────────────────────────
  // Operator-triggered only: views are built when someone asks, never on the
  // onboarding path and never lazily on read. Until then a capability has no
  // view rows and every consumer degrades to the capability-wide world model.

  // POST /capabilities/:id/world-model/views/build
  // Body: { views?: kind[] | "auto", domainKeys?: string[], task?: string }
  // 202 + fire-and-forget: a full build is one LLM call per view, far longer
  // than a request should hold. Poll GET .../views for status.
  async buildWorldModelViews(req: Request, res: Response) {
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    if (!viewBuildEnabled()) {
      return res.status(409).json({
        error: "world-model view distillation is not configured",
        fixCommand: "set WORLD_MODEL_VIEWS_MODEL_ALIAS (or WORLD_MODEL_DISTILL_MODEL_ALIAS) to a configured gateway model alias",
      });
    }
    if (isBuildInFlight(req.params.id)) {
      return res.status(409).json({ error: "a view build is already running for this capability" });
    }

    const plan = planViewBuild(req.body ?? {});
    if (!plan.ok) return res.status(400).json({ error: plan.error });

    void buildViews(req.params.id, plan.views).catch(() => undefined);
    return res.status(202).json({
      success: true,
      data: { capabilityId: req.params.id, building: plan.views },
    });
  },

  // GET /capabilities/:id/world-model/views — the manifest, derived from rows.
  // `stale` compares each view's build fingerprint against the capability's
  // current one, so drift needs no extra bookkeeping. `?include=content`
  // returns the prose + evidence too (used by the repo export).
  async listWorldModelViews(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    const [views, worldModel] = await Promise.all([listViews(req.params.id), getWorldModel(req.params.id)]);
    const current = worldModel?.repoFingerprint ?? null;
    const includeContent = req.query.include === "content";
    return ok(
      res,
      {
        capabilityId: req.params.id,
        repoFingerprint: current,
        views: views.map((v) => ({
          kind: v.kind,
          domainKey: v.domainKey,
          title: v.title,
          status: v.status,
          stale: isViewStale(v.repoFingerprint, current),
          tokenEstimate: v.tokenEstimate,
          contentHash: v.contentHash,
          sourceCommit: v.sourceCommit,
          generatedBy: v.generatedBy,
          generatedAt: v.generatedAt,
          buildError: v.buildError,
          ...(includeContent ? { contentMd: v.contentMd, structured: v.structured, evidence: v.evidence } : {}),
        })),
      },
      200,
    );
  },

  async getWorldModelView(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    const kind = req.params.kind;
    if (!isWorldModelViewKind(kind)) return res.status(400).json({ error: `unknown view kind: ${kind}` });
    const domainKey = typeof req.query.domainKey === "string" ? req.query.domainKey : "";
    const view = await getView(req.params.id, kind, domainKey);
    if (!view) return res.status(404).json({ error: "view not built for this capability" });
    const worldModel = await getWorldModel(req.params.id);
    return ok(res, { ...view, stale: isViewStale(view.repoFingerprint, worldModel?.repoFingerprint ?? null) }, 200);
  },

  async deleteWorldModelView(req: Request, res: Response) {
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    const kind = req.params.kind;
    if (!isWorldModelViewKind(kind)) return res.status(400).json({ error: `unknown view kind: ${kind}` });
    const domainKey = typeof req.query.domainKey === "string" ? req.query.domainKey : "";
    const deleted = await deleteView(req.params.id, kind, domainKey);
    if (!deleted) return res.status(404).json({ error: "view not built for this capability" });
    return ok(res, { capabilityId: req.params.id, kind, domainKey, deleted: true }, 200);
  },

  // GET /capabilities/world-model/view-specs
  //
  // The build prompts themselves, as the builder will actually use them. Reading
  // what a view was TOLD to produce previously meant reading the source at the
  // deployed commit; this makes the effective config inspectable, including
  // whether an override is active and any warnings it produced.
  //
  // Not capability-scoped: the specs are platform-wide.
  async getWorldModelViewSpecs(_req: Request, res: Response) {
    const loaded = loadViewSpecsWithMeta();
    return ok(
      res,
      {
        source: loaded.source,
        overrideActive: loaded.source !== "default",
        warnings: loaded.warnings,
        // The env NAMES, never their contents: an override may be a file path,
        // and echoing raw config back over HTTP is how paths leak.
        configuredBy: {
          inline: Boolean(process.env.WORLD_MODEL_VIEW_SPECS_JSON?.trim()),
          path: Boolean(process.env.WORLD_MODEL_VIEW_SPECS_PATH?.trim()),
        },
        specs: allViewSpecs(),
      },
      200,
    );
  },

  // GET /capabilities/:id/world-model/slice?role=&task=&domainKey=
  //
  // The single call context-fabric makes per turn: hand it a role, get back the
  // capability's world model plus only the views that role should read.
  //
  // 404 only when the capability has neither a world model nor any views. A
  // parent capability with views but no world model is a valid slice — that is
  // the whole point of building views for capabilities without repositories.
  // `views: []` is likewise valid and means "nobody has built views yet", which
  // is exactly today's behaviour for every caller.
  async getWorldModelSliceForRole(req: Request, res: Response) {
    assertCapabilityReadScope(req.user, req.params.id);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const slice = await getWorldModelSlice(req.params.id, {
      role: str(req.query.role),
      task: str(req.query.task),
      domainKey: str(req.query.domainKey),
    });
    if (!slice.worldModel && slice.views.length === 0) {
      return res.status(404).json({ error: "no world model or views for this capability" });
    }
    return ok(res, slice, 200);
  },

  // POST /capabilities/:id/world-model/redistill — refresh grounding on demand
  // (re-run the LLM enrichment + architecture slice + upsert) without
  // re-onboarding. Returns the distillation stats.
  async redistillWorldModel(req: Request, res: Response) {
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    const stats = await distillAndUpsertWorldModel(req.params.id);
    if (stats.skipped) {
      return res.status(409).json({ error: "nothing to distill — no README candidate or indexed symbols for this capability" });
    }
    return ok(res, { capabilityId: req.params.id, ...stats }, 200);
  },

  async checkWorldModelFingerprint(req: Request, res: Response) {
    const body = req.body as { fingerprint?: unknown; hashedBuildFiles?: unknown; topLevelEntries?: unknown };
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
    if (!fingerprint) return res.status(400).json({ error: "fingerprint is required" });
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    const hashedBuildFiles = Array.isArray(body.hashedBuildFiles)
      ? body.hashedBuildFiles.filter((s): s is string => typeof s === "string")
      : undefined;
    const topLevelEntries = Array.isArray(body.topLevelEntries)
      ? body.topLevelEntries.filter((s): s is string => typeof s === "string")
      : undefined;
    const result = await worldModelDriftService.recordFingerprint(req.params.id, {
      fingerprint,
      hashedBuildFiles,
      topLevelEntries,
      actorId: req.user?.user_id,
    });
    return ok(res, result, 200);
  },

  // M61 Wire B P2 — AST index callback.
  //
  // POST /capabilities/:id/world-model/ast-index-built
  // Body: { astIndexFiles: number }
  //
  // mcp-server fires this after building (or refreshing) its tree-sitter
  // AST index for the capability's workspace. We stamp astIndexedAt =
  // now() + astIndexFiles on the world-model row so consumers (the
  // Slice F CODE_WORLD_MODEL layer renderer, future Phase 2 worker
  // observability) can tell the index is ready without polling
  // mcp-server.
  //
  // Idempotent: re-firing the call simply bumps astIndexedAt.
  // M61 Wire D — POST /capabilities/:id/world-model/probe-command
  // Body: { cmd, cwd? }
  // Returns: { exitCode, signal, timedOut, durationMs, stdout, stderr, … }
  //
  // Spawns the command in an isolated tmp dir under /tmp. The :id
  // capability route param is currently a soft anchor — the probe
  // itself doesn't read any capability state — but we keep it on the
  // URL so future expansions (probe inside the capability's cloned
  // repo) don't have to change the wire shape.
  async probeWorldModelCommand(req: Request, res: Response) {
    const body = req.body as { cmd?: unknown; cwd?: unknown };
    const cmd = typeof body.cmd === "string" ? body.cmd.trim() : "";
    if (!cmd) return res.status(400).json({ error: "cmd is required" });
    if (cmd.length > 500) return res.status(400).json({ error: "cmd too long (max 500)" });
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;
    if (cwd && cwd.length > 200) return res.status(400).json({ error: "cwd too long (max 200)" });
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    const result = await probeCommand({ cmd, cwd });
    return ok(res, result, 200);
  },

  async reportAstIndexBuilt(req: Request, res: Response) {
    const body = req.body as { astIndexFiles?: unknown };
    const n = typeof body.astIndexFiles === "number" && Number.isFinite(body.astIndexFiles)
      ? Math.max(0, Math.floor(body.astIndexFiles))
      : 0;
    await assertCapabilityMutable(req.params.id, "Capability is archived; world-model maintenance is read-only.");
    const out = await upsertWorldModel({
      capabilityId: req.params.id,
      astIndexedAt: new Date(),
      astIndexFiles: n,
    });
    return ok(res, { astIndexedAt: out.astIndexedAt, astIndexFiles: out.astIndexFiles }, 200);
  },
};
