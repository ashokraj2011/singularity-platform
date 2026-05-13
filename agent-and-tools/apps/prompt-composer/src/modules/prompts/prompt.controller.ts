import { Request, Response } from "express";
import { promptService } from "./prompt.service";
import { promptAssemblyService } from "./prompt-assembly.service";
import { ok } from "../../shared/response";
import { prisma } from "../../config/prisma";

export const promptController = {
  async createProfile(req: Request, res: Response) {
    return ok(res, await promptService.createProfile(req.body), 201);
  },
  async listProfiles(_req: Request, res: Response) {
    return ok(res, await promptService.listProfiles());
  },
  async getProfile(req: Request, res: Response) {
    return ok(res, await promptService.getProfile(req.params.id));
  },

  async createLayer(req: Request, res: Response) {
    return ok(res, await promptService.createLayer(req.body), 201);
  },
  async updateLayer(req: Request, res: Response) {
    return ok(res, await promptService.updateLayer(req.params.id, req.body));
  },
  async listLayers(req: Request, res: Response) {
    return ok(res, await promptService.listLayers(req.query as never));
  },

  async attachLayer(req: Request, res: Response) {
    const link = await promptService.attachLayer(
      req.params.profileId,
      req.body.promptLayerId,
      req.body.priority,
      req.body.isEnabled,
    );
    return ok(res, link, 201);
  },

  async assemble(req: Request, res: Response) {
    return ok(res, await promptAssemblyService.assemble(req.body), 201);
  },

  async getAssembly(req: Request, res: Response) {
    const assembly = await prisma.promptAssembly.findUnique({
      where: { id: req.params.id },
      include: { layers: { orderBy: { priority: "asc" } } },
    });
    if (!assembly) {
      res.status(404).json({
        success: false,
        data: null,
        error: { code: "NOT_FOUND", message: "Assembly not found" },
        requestId: res.locals.requestId,
      });
      return;
    }
    return ok(res, assembly);
  },
};
