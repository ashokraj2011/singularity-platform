import { Request, Response } from "express";
import { capabilityService } from "./capability.service";
import { syncKnowledgeSourceNow, syncRepositoryNow } from "./poll-worker";
import { ok } from "../../shared/response";
// M61 Slice E — repo-fingerprint drift detection. Exposed as a thin
// REST endpoint so any caller with a workspace on disk (mcp-server,
// workgraph-api, an operator script) can submit a fingerprint without
// pulling in the world-model.service or Prisma client.
import { worldModelDriftService } from "./world-model-drift.service";
// M61 Wire B P2 — AST index callback writes astIndexedAt + astIndexFiles
// to the world-model row when mcp-server reports the index is built.
import { upsertWorldModel } from "./world-model.service";
// M61 Wire D — Verify-now command probe powering the wizard's per-row
// "Verify" button. Spawns the cmd in an isolated tmp dir with a 10s
// timeout; returns exit code + capped stdout/stderr.
import { probeCommand } from "./command-probe.service";
// pdf-parse ships a CommonJS bundle whose root index.js triggers test code
// when imported without a file path. Importing the lib subpath skips that.
// @ts-expect-error — sub-path has no bundled types; we type the call shape locally below.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
type PdfParseFn = (data: Buffer) => Promise<{ text?: string }>;
const pdfExtract = pdfParse as unknown as PdfParseFn;

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
  async list(_req: Request, res: Response) {
    return ok(res, await capabilityService.list());
  },
  async get(req: Request, res: Response) {
    return ok(res, await capabilityService.get(req.params.id));
  },
  async readiness(req: Request, res: Response) {
    return ok(res, await capabilityService.readiness(req.params.id));
  },
  async architectureDiagram(req: Request, res: Response) {
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
  async attachRepo(req: Request, res: Response) {
    return ok(res, await capabilityService.attachRepository(req.params.id, req.body), 201);
  },
  async bindAgent(req: Request, res: Response) {
    return ok(res, await capabilityService.bindAgent(req.params.id, req.body, req.user?.user_id), 201);
  },
  async listBindings(req: Request, res: Response) {
    return ok(res, await capabilityService.listBindings(req.params.id));
  },
  async addKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.addKnowledge(req.params.id, req.body), 201);
  },
  async listKnowledge(req: Request, res: Response) {
    return ok(res, await capabilityService.listKnowledge(req.params.id));
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

    const artifactType = (req.body.artifactType as string | undefined) ?? "DOC";
    const baseConf = Number(req.body.confidence ?? 0.9);
    const created: Array<Record<string, unknown>> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const f of files) {
      let content: string;
      try {
        if (
          f.mimetype === "text/plain" ||
          f.mimetype === "text/markdown" ||
          /\.(txt|md|markdown)$/i.test(f.originalname)
        ) {
          content = f.buffer.toString("utf8");
        } else if (f.mimetype === "application/pdf" || /\.pdf$/i.test(f.originalname)) {
          const parsed = await pdfExtract(f.buffer);
          content = (parsed.text ?? "").trim();
          if (!content) {
            skipped.push({ name: f.originalname, reason: "pdf-empty" });
            continue;
          }
        } else {
          skipped.push({ name: f.originalname, reason: `unsupported mime: ${f.mimetype}` });
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
  async checkWorldModelFingerprint(req: Request, res: Response) {
    const body = req.body as { fingerprint?: unknown; hashedBuildFiles?: unknown; topLevelEntries?: unknown };
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
    if (!fingerprint) return res.status(400).json({ error: "fingerprint is required" });
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
    const result = await probeCommand({ cmd, cwd });
    return ok(res, result, 200);
  },

  async reportAstIndexBuilt(req: Request, res: Response) {
    const body = req.body as { astIndexFiles?: unknown };
    const n = typeof body.astIndexFiles === "number" && Number.isFinite(body.astIndexFiles)
      ? Math.max(0, Math.floor(body.astIndexFiles))
      : 0;
    const out = await upsertWorldModel({
      capabilityId: req.params.id,
      astIndexedAt: new Date(),
      astIndexFiles: n,
    });
    return ok(res, { astIndexedAt: out.astIndexedAt, astIndexFiles: out.astIndexFiles }, 200);
  },
};
