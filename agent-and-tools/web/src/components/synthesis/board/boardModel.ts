/**
 * Pure, framework-free model for the Strategy Canvas view of the Idea Board.
 *
 * It maps the initiative's *existing* claims and probes to colour-coded sticky
 * notes and lays them out deterministically as "theme area" frames (one per
 * room) with a grid of notes inside each. Nothing here touches React, the
 * network, or the DOM, so it can be unit-tested directly with ts-node and reused
 * by the canvas component for a stable first render.
 *
 * v1 is a visual projection only — positions are seeded from claim/probe ids so
 * the board is identical across renders and is never persisted.
 */

import { isContested } from "../logic";
import type { SynClaim, SynProbe, SynRoom } from "../types";

/* ─── Sticky taxonomy ───────────────────────────────────────────────────── */

export type StickyKind =
  | "KNOWN_FACT"
  | "RISKY_ASSUMPTION"
  | "VALIDATION_PROBE"
  | "OPEN_QUESTION";

export interface StickyMeta {
  /** ALL-CAPS label rendered on the note. */
  label: string;
  /** `#TAG` shown bottom-right. */
  tag: string;
  /** Semantic palette key → CSS custom properties in synthesis.css. */
  palette: "green" | "red" | "blue" | "yellow";
}

export const KIND_META: Record<StickyKind, StickyMeta> = {
  KNOWN_FACT: { label: "KNOWN FACT", tag: "#INSIGHT", palette: "green" },
  RISKY_ASSUMPTION: { label: "RISKY ASSUMPTION", tag: "#CRITICAL", palette: "red" },
  VALIDATION_PROBE: { label: "VALIDATION PROBE", tag: "#TEST", palette: "blue" },
  OPEN_QUESTION: { label: "HOW IS THIS IDEA", tag: "#QUERY", palette: "yellow" },
};

/** Backed = corroborated by more than one estimator. */
const HIGH_CONFIDENCE_MEAN = 0.65;

/**
 * Derive a sticky kind from a claim's epistemic signals. Order matters:
 * contested beats confidence so genuinely disputed claims always read as risk.
 */
export function stickyKindForClaim(claim: SynClaim): StickyKind {
  if (isContested(claim)) return "RISKY_ASSUMPTION";
  const backed = (claim.estimateCount ?? 0) > 1;
  if ((claim.mean ?? 0) >= HIGH_CONFIDENCE_MEAN && backed) return "KNOWN_FACT";
  return "OPEN_QUESTION";
}

/* ─── Board geometry ────────────────────────────────────────────────────── */

export const NOTE_W = 208;
export const NOTE_H = 140;
export const NOTE_GAP = 24;
export const FRAME_PAD = 28;
export const FRAME_HEADER = 46;
export const FRAME_GAP = 64;
export const CANVAS_MARGIN = 72;
/** Notes per row inside a frame, and frames per row on the board. */
export const NOTE_COLS = 3;
export const FRAMES_PER_ROW = 2;

const UNASSIGNED_ROOM = "__unassigned__";

export interface BoardNote {
  /** Stable, source-prefixed id (`claim:<id>` / `probe:<id>`). */
  id: string;
  kind: StickyKind;
  sourceType: "claim" | "probe";
  sourceId: string;
  roomId: string;
  /** Note id of the parent claim, for probes. */
  parentId?: string;
  body: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardFrame {
  roomId: string;
  /** ALL-CAPS theme label, e.g. `THEME AREA: MARKET HYPOTHESIS`. */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  noteIds: string[];
}

export interface BoardConnector {
  id: string;
  /** Probe note id. */
  fromId: string;
  /** Parent claim note id. */
  toId: string;
}

export interface BoardModel {
  notes: BoardNote[];
  frames: BoardFrame[];
  connectors: BoardConnector[];
  bounds: { w: number; h: number };
}

export interface BoardInput {
  rooms: SynRoom[];
  claims: SynClaim[];
  probes: SynProbe[];
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function noteId(sourceType: "claim" | "probe", sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function claimBody(claim: SynClaim): string {
  return claim.statement || claim.riskiestAssumption || "Untitled claim";
}

function probeBody(probe: SynProbe): string {
  return probe.falsification || probe.riskiestAssumption || "Validation probe";
}

function frameLabel(title: string): string {
  return `THEME AREA: ${(title || "General").toUpperCase()}`;
}

/**
 * Build the full board model from existing claims/probes. Deterministic: given
 * the same inputs it always returns identical geometry (rooms, claims, and
 * probes are ordered by id, then packed row-major).
 */
export function buildBoardModel(input: BoardInput): BoardModel {
  const rooms = [...input.rooms].sort(byId);
  const claims = [...input.claims].sort(byId);
  const probes = [...input.probes].sort(byId);

  const knownRoomIds = new Set(rooms.map((r) => r.id));
  const claimById = new Map(claims.map((c) => [c.id, c]));

  // Probes grouped by parent claim (only those whose parent claim is present).
  const probesByClaim = new Map<string, SynProbe[]>();
  for (const probe of probes) {
    if (!claimById.has(probe.claimId)) continue;
    const list = probesByClaim.get(probe.claimId) ?? [];
    list.push(probe);
    probesByClaim.set(probe.claimId, list);
  }

  // Claims grouped by their (known) room, else an unassigned bucket.
  const claimsByRoom = new Map<string, SynClaim[]>();
  for (const claim of claims) {
    const roomId = claim.roomId && knownRoomIds.has(claim.roomId) ? claim.roomId : UNASSIGNED_ROOM;
    const list = claimsByRoom.get(roomId) ?? [];
    list.push(claim);
    claimsByRoom.set(roomId, list);
  }

  // Frame order: known rooms (by id) first, unassigned last if it has claims.
  const frameRoomIds = rooms.filter((r) => claimsByRoom.has(r.id)).map((r) => r.id);
  if (claimsByRoom.has(UNASSIGNED_ROOM)) frameRoomIds.push(UNASSIGNED_ROOM);

  const roomTitle = new Map(rooms.map((r) => [r.id, r.title] as const));

  const notes: BoardNote[] = [];
  const frames: BoardFrame[] = [];
  const connectors: BoardConnector[] = [];

  let col = 0;
  let cursorX = CANVAS_MARGIN;
  let cursorY = CANVAS_MARGIN;
  let rowMaxH = 0;
  let maxRight = 0;
  let maxBottom = 0;

  for (const roomId of frameRoomIds) {
    const roomClaims = claimsByRoom.get(roomId) ?? [];

    // Ordered notes for this frame: each claim followed by its probes.
    const frameNotes: BoardNote[] = [];
    for (const claim of roomClaims) {
      const cNoteId = noteId("claim", claim.id);
      frameNotes.push({
        id: cNoteId,
        kind: stickyKindForClaim(claim),
        sourceType: "claim",
        sourceId: claim.id,
        roomId,
        body: claimBody(claim),
        x: 0,
        y: 0,
        w: NOTE_W,
        h: NOTE_H,
      });
      for (const probe of probesByClaim.get(claim.id) ?? []) {
        const pNoteId = noteId("probe", probe.id);
        frameNotes.push({
          id: pNoteId,
          kind: "VALIDATION_PROBE",
          sourceType: "probe",
          sourceId: probe.id,
          roomId,
          parentId: cNoteId,
          body: probeBody(probe),
          x: 0,
          y: 0,
          w: NOTE_W,
          h: NOTE_H,
        });
        connectors.push({ id: `${pNoteId}->${cNoteId}`, fromId: pNoteId, toId: cNoteId });
      }
    }

    const count = frameNotes.length;
    const innerCols = Math.max(1, Math.min(NOTE_COLS, count));
    const rows = Math.max(1, Math.ceil(count / innerCols));
    const contentW = innerCols * NOTE_W + (innerCols - 1) * NOTE_GAP;
    const contentH = rows * NOTE_H + (rows - 1) * NOTE_GAP;
    const frameW = contentW + FRAME_PAD * 2;
    const frameH = FRAME_HEADER + contentH + FRAME_PAD;

    // Wrap to a new shelf after FRAMES_PER_ROW frames.
    if (col === FRAMES_PER_ROW) {
      col = 0;
      cursorX = CANVAS_MARGIN;
      cursorY += rowMaxH + FRAME_GAP;
      rowMaxH = 0;
    }

    const frameX = cursorX;
    const frameY = cursorY;

    frameNotes.forEach((note, i) => {
      const c = i % innerCols;
      const r = Math.floor(i / innerCols);
      note.x = frameX + FRAME_PAD + c * (NOTE_W + NOTE_GAP);
      note.y = frameY + FRAME_HEADER + r * (NOTE_H + NOTE_GAP);
      notes.push(note);
    });

    frames.push({
      roomId,
      label: frameLabel(roomId === UNASSIGNED_ROOM ? "Unassigned" : roomTitle.get(roomId) ?? "General"),
      x: frameX,
      y: frameY,
      w: frameW,
      h: frameH,
      noteIds: frameNotes.map((n) => n.id),
    });

    cursorX += frameW + FRAME_GAP;
    rowMaxH = Math.max(rowMaxH, frameH);
    maxRight = Math.max(maxRight, frameX + frameW);
    maxBottom = Math.max(maxBottom, frameY + frameH);
    col += 1;
  }

  return {
    notes,
    frames,
    connectors,
    bounds: {
      w: (maxRight || CANVAS_MARGIN) + CANVAS_MARGIN,
      h: (maxBottom || CANVAS_MARGIN) + CANVAS_MARGIN,
    },
  };
}
