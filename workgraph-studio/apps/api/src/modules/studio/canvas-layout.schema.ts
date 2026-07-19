/**
 * Zod schemas for the Strategy Canvas layout API, split out so they can be unit-tested without
 * importing the router (which pulls in prisma / minio / config). The PUT body is the source of truth
 * for what a persisted per-user layout may contain: sticky position overrides + free-form annotation
 * objects (text / shape / pen / image) + an optional viewport.
 */
import { z } from "zod";

const point = z.object({ x: z.number(), y: z.number() });

const baseObject = {
  id: z.string().trim().min(1).max(80),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  color: z.string().trim().max(40).optional(),
};

export const canvasObjectSchema = z.discriminatedUnion("type", [
  z.object({ ...baseObject, type: z.literal("text"), text: z.string().max(4000).default("") }),
  z.object({
    ...baseObject,
    type: z.literal("shape"),
    shape: z.enum(["rect", "ellipse"]).default("rect"),
  }),
  z.object({
    ...baseObject,
    type: z.literal("pen"),
    points: z.array(z.number()).max(20000),
    strokeWidth: z.number().min(0.5).max(40).optional(),
  }),
  z.object({
    ...baseObject,
    type: z.literal("image"),
    storageKey: z.string().trim().min(1).max(600),
    bucket: z.string().trim().max(120).optional(),
    mimeType: z.string().trim().max(120).optional(),
  }),
]);

export const saveLayoutSchema = z.object({
  positions: z.record(point).default({}),
  objects: z.array(canvasObjectSchema).max(2000).default([]),
  viewport: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable().optional(),
});

export type CanvasObjectInput = z.infer<typeof canvasObjectSchema>;
export type SaveLayoutInput = z.infer<typeof saveLayoutSchema>;
