/**
 * Pure, framework-free helpers for the *persistent, per-user* layer of the Strategy Canvas.
 *
 * The board's sticky notes are derived from claims/probes by `boardModel.ts`. This module models the
 * personal layer a user saves on top of that projection — sticky position overrides and free-form
 * annotation objects (text / shape / pen / image) — plus the small amount of logic that has to be
 * exactly right and is worth unit-testing away from React: merging saved positions over the
 * deterministic defaults, stripping transient fields before persisting, and an undo/redo history.
 *
 * Nothing here touches React, the network, or the DOM.
 */

export interface CanvasPoint {
  x: number;
  y: number;
}

export type Positions = Record<string, CanvasPoint>;

export interface CanvasViewport {
  x: number;
  y: number;
  z: number;
}

interface BaseObject {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
}

export interface TextObject extends BaseObject {
  type: "text";
  text: string;
}
export interface ShapeObject extends BaseObject {
  type: "shape";
  shape: "rect" | "ellipse";
}
export interface PenObject extends BaseObject {
  type: "pen";
  /** Flattened [x0,y0,x1,y1,…] in board coordinates. */
  points: number[];
  strokeWidth?: number;
}
export interface ImageObject extends BaseObject {
  type: "image";
  storageKey: string;
  bucket?: string;
  mimeType?: string;
  /** Presigned read URL, supplied by the server on load — NEVER persisted. */
  url?: string | null;
}

export type CanvasObject = TextObject | ShapeObject | PenObject | ImageObject;

export interface CanvasDoc {
  positions: Positions;
  objects: CanvasObject[];
}

export const EMPTY_DOC: CanvasDoc = { positions: {}, objects: [] };

/**
 * Merge a user's saved sticky positions over the deterministic defaults. Only notes that still exist
 * keep an entry (so stale overrides for deleted claims are dropped), and a saved override always wins
 * over the default seed.
 */
export function mergeNotePositions(
  noteDefaults: { id: string; x: number; y: number }[],
  saved: Positions | null | undefined,
): Positions {
  const next: Positions = {};
  for (const note of noteDefaults) {
    const override = saved?.[note.id];
    next[note.id] = override ? { x: override.x, y: override.y } : { x: note.x, y: note.y };
  }
  return next;
}

/**
 * Strip transient, server-derived fields (image presigned `url`) so a saved layout only carries the
 * durable descriptor. Persisting the URL would bake in an expiring signature.
 */
export function serializeObjects(objects: CanvasObject[]): CanvasObject[] {
  return objects.map((obj) => {
    if (obj.type === "image") {
      const { url: _url, ...rest } = obj;
      return rest;
    }
    return obj;
  });
}

export interface SaveLayoutPayload {
  positions: Positions;
  objects: CanvasObject[];
  viewport: CanvasViewport | null;
}

/** Shape a doc + viewport into the exact PUT body the API expects, dropping transient fields. */
export function toSavePayload(doc: CanvasDoc, viewport: CanvasViewport | null): SaveLayoutPayload {
  return {
    positions: doc.positions,
    objects: serializeObjects(doc.objects),
    viewport,
  };
}

/* ─── Undo / redo history ───────────────────────────────────────────────── */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const HISTORY_LIMIT = 60;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Commit a new present, pushing the old one onto the undo stack and clearing redo. */
export function pushHistory<T>(history: History<T>, next: T, limit = HISTORY_LIMIT): History<T> {
  if (Object.is(next, history.present)) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: next,
    future: [],
  };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const present = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [present, ...future] = history.future;
  return {
    past: [...history.past, history.present],
    present,
    future,
  };
}

export const canUndo = <T>(history: History<T>): boolean => history.past.length > 0;
export const canRedo = <T>(history: History<T>): boolean => history.future.length > 0;
