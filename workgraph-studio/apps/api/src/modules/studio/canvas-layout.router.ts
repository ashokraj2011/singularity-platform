/**
 * Strategy Canvas layout API — mounted at /api/studio behind authMiddleware + studioAuthz.
 *
 * Per-user personal layout for the Synthesis Idea Board: sticky position overrides, free-form
 * annotation objects (text / shape / pen / image), and the last viewport. Keyed by the authenticated
 * user + project, so a user's arrangement is private to them (see canvas-layout.service.ts).
 */
import { Router, type Request } from "express";
import multer from "multer";
import { validate } from "../../middleware/validate";
import { boundedByteLimit } from "../../lib/env-limits";
import { saveLayoutSchema } from "./canvas-layout.schema";
import {
  getCanvasLayout,
  saveCanvasLayout,
  uploadCanvasImage,
} from "./canvas-layout.service";

export const canvasLayoutRouter: Router = Router();

const userId = (req: Request) => req.user!.userId;
const projectId = (req: Request) => String(req.params.projectId);

// Images live in object storage (MinIO), never inline in the layout row. Cap defends the row + bucket;
// anything larger belongs in the document store as an attachment.
const MAX_CANVAS_IMAGE_BYTES = boundedByteLimit(process.env.MAX_CANVAS_IMAGE_BYTES, {
  defaultBytes: 10 * 1024 * 1024,
  minBytes: 1,
  maxBytes: 50 * 1024 * 1024,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CANVAS_IMAGE_BYTES } });

canvasLayoutRouter.get("/projects/:projectId/canvas-layout", async (req, res, next) => {
  try {
    res.json(await getCanvasLayout(projectId(req), userId(req)));
  } catch (e) {
    next(e);
  }
});

canvasLayoutRouter.put(
  "/projects/:projectId/canvas-layout",
  validate(saveLayoutSchema),
  async (req, res, next) => {
    try {
      res.json(
        await saveCanvasLayout(projectId(req), userId(req), {
          positions: req.body.positions,
          objects: req.body.objects,
          viewport: req.body.viewport ?? null,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);

canvasLayoutRouter.post(
  "/projects/:projectId/canvas-layout/images",
  upload.single("file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ code: "BAD_REQUEST", message: 'No file uploaded (expected multipart field "file")' });
        return;
      }
      if (!file.mimetype.startsWith("image/")) {
        res.status(400).json({ code: "BAD_REQUEST", message: "Only image uploads are supported on the canvas" });
        return;
      }
      res.status(201).json(await uploadCanvasImage(projectId(req), file));
    } catch (e) {
      next(e);
    }
  },
);
