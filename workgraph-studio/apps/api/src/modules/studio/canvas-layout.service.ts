/**
 * Strategy Canvas layout service — per-user personal arrangement for the Synthesis Idea Board.
 *
 * The board's sticky notes are DERIVED on the client from a project's claims/probes; this layer only
 * persists each user's personal layer on top of that projection: sticky position overrides, free-form
 * annotation objects (text / shape / pen / image), and the last viewport. It is intentionally personal
 * (one row per user+project) — rearranging your board never moves anyone else's.
 *
 * Access is guarded by getProject() (tenant + existence); the row is written with the caller's userId.
 */
import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../../lib/prisma";
import { currentTenantIdForDb } from "../../lib/tenant-db-context";
import { minioClient } from "../../lib/minio";
import { config } from "../../config";
import { getProject } from "./studio-projects.service";

const tenant = () => currentTenantIdForDb() ?? undefined;

export interface CanvasLayoutPayload {
  positions: Prisma.InputJsonValue;
  objects: Prisma.InputJsonValue;
  viewport?: Prisma.InputJsonValue | null;
}

export interface CanvasLayoutDto {
  positions: unknown;
  objects: unknown;
  viewport: unknown;
  updatedAt: string | null;
}

const EMPTY: CanvasLayoutDto = { positions: {}, objects: [], viewport: null, updatedAt: null };

/** Presign the storage keys of any image objects so the browser can render them. */
async function withImageUrls(objects: unknown): Promise<unknown> {
  if (!Array.isArray(objects)) return objects;
  return Promise.all(
    objects.map(async (obj) => {
      if (!obj || typeof obj !== "object") return obj;
      const o = obj as Record<string, unknown>;
      if (o.type !== "image" || typeof o.storageKey !== "string") return obj;
      const bucket = typeof o.bucket === "string" ? o.bucket : config.MINIO_BUCKET;
      try {
        const url = await minioClient.presignedGetObject(bucket, o.storageKey, 3600);
        return { ...o, url };
      } catch {
        // Object may have been evicted out-of-band; return without a URL rather than failing the read.
        return { ...o, url: null };
      }
    }),
  );
}

export async function getCanvasLayout(projectId: string, userId: string): Promise<CanvasLayoutDto> {
  await getProject(projectId);
  const row = await prisma.synthesisCanvasLayout.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!row) return EMPTY;
  return {
    positions: row.positions,
    objects: await withImageUrls(row.objects),
    viewport: row.viewport,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveCanvasLayout(
  projectId: string,
  userId: string,
  input: CanvasLayoutPayload,
): Promise<CanvasLayoutDto> {
  await getProject(projectId);
  const viewport = input.viewport ?? undefined;
  const row = await prisma.synthesisCanvasLayout.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: {
      projectId,
      userId,
      tenantId: tenant(),
      positions: input.positions,
      objects: input.objects,
      viewport,
    },
    update: {
      positions: input.positions,
      objects: input.objects,
      viewport,
    },
  });
  return {
    positions: row.positions,
    objects: await withImageUrls(row.objects),
    viewport: row.viewport,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface UploadedCanvasImage {
  storageKey: string;
  bucket: string;
  mimeType: string;
  url: string;
}

/** Store an uploaded image in object storage and hand back a descriptor + a presigned URL. */
export async function uploadCanvasImage(
  projectId: string,
  file: { originalname: string; buffer: Buffer; size: number; mimetype: string },
): Promise<UploadedCanvasImage> {
  await getProject(projectId);
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storageKey = `synthesis-canvas/${projectId}/${randomUUID()}-${safeName}`;
  const bucket = config.MINIO_BUCKET;
  await minioClient.putObject(bucket, storageKey, file.buffer, file.size, {
    "Content-Type": file.mimetype,
  });
  const url = await minioClient.presignedGetObject(bucket, storageKey, 3600);
  return { storageKey, bucket, mimeType: file.mimetype, url };
}
