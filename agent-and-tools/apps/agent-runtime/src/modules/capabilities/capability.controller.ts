import { Request, Response } from "express";
import { capabilityService } from "./capability.service";
import { ok } from "../../shared/response";
// pdf-parse ships a CommonJS bundle whose root index.js triggers test code
// when imported without a file path. Importing the lib subpath skips that.
// @ts-expect-error — sub-path has no bundled types; we type the call shape locally below.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
type PdfParseFn = (data: Buffer) => Promise<{ text?: string }>;
const pdfExtract = pdfParse as unknown as PdfParseFn;

export const capabilityController = {
  async create(req: Request, res: Response) {
    return ok(res, await capabilityService.create(req.body), 201);
  },
  async list(_req: Request, res: Response) {
    return ok(res, await capabilityService.list());
  },
  async get(req: Request, res: Response) {
    return ok(res, await capabilityService.get(req.params.id));
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
};
