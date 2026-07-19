import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  KIND_META,
  NOTE_W,
  NOTE_H,
  buildBoardModel,
  stickyKindForClaim,
  type BoardInput,
} from "./boardModel";
import type { SynClaim, SynProbe, SynRoom } from "../types";

/* ─── claim → sticky-kind mapping ───────────────────────────────────────── */

// Contested (high estimator variance) always reads as risk, even when confident.
assert.equal(
  stickyKindForClaim({ id: "c", disagreement: 0.06, mean: 0.9, estimateCount: 5 } as SynClaim),
  "RISKY_ASSUMPTION",
  "contested claim is a risky assumption",
);

// High confidence + backed by more than one estimator → known fact.
assert.equal(
  stickyKindForClaim({ id: "c", mean: 0.7, estimateCount: 3, disagreement: 0.01 } as SynClaim),
  "KNOWN_FACT",
  "high-confidence backed claim is a known fact",
);

// Confident but only one estimator (unbacked) → still an open question.
assert.equal(
  stickyKindForClaim({ id: "c", mean: 0.9, estimateCount: 1, disagreement: 0.01 } as SynClaim),
  "OPEN_QUESTION",
  "unbacked high mean is an open question, not a fact",
);

// Low posterior → open question.
assert.equal(
  stickyKindForClaim({ id: "c", mean: 0.2, estimateCount: 4, disagreement: 0.01 } as SynClaim),
  "OPEN_QUESTION",
  "low-confidence claim is an open question",
);

// Empty claim defaults to open question (mean defaults handled downstream).
assert.equal(stickyKindForClaim({ id: "c" } as SynClaim), "OPEN_QUESTION");

/* ─── kind metadata (colours + tags match the mockup) ───────────────────── */

assert.equal(KIND_META.KNOWN_FACT.tag, "#INSIGHT");
assert.equal(KIND_META.KNOWN_FACT.palette, "green");
assert.equal(KIND_META.RISKY_ASSUMPTION.tag, "#CRITICAL");
assert.equal(KIND_META.RISKY_ASSUMPTION.palette, "red");
assert.equal(KIND_META.VALIDATION_PROBE.tag, "#TEST");
assert.equal(KIND_META.VALIDATION_PROBE.palette, "blue");
assert.equal(KIND_META.OPEN_QUESTION.tag, "#QUERY");
assert.equal(KIND_META.OPEN_QUESTION.palette, "yellow");

/* ─── layout fixture ────────────────────────────────────────────────────── */

const rooms: SynRoom[] = [
  { id: "room-b", title: "Assumption Map", projectId: "p" },
  { id: "room-a", title: "Market Hypothesis", projectId: "p" },
];
const claims: SynClaim[] = [
  { id: "claim-2", projectId: "p", roomId: "room-a", statement: "Buyers pay for SSO", mean: 0.8, estimateCount: 4, disagreement: 0.01 },
  { id: "claim-1", projectId: "p", roomId: "room-a", statement: "Market is contested", mean: 0.5, estimateCount: 3, disagreement: 0.09 },
  { id: "claim-3", projectId: "p", roomId: "room-b", statement: "Onboarding is unclear", mean: 0.3, estimateCount: 1, disagreement: 0.0 },
  { id: "claim-orphan", projectId: "p", roomId: "room-missing", statement: "No known room", mean: 0.5, estimateCount: 2, disagreement: 0.0 },
];
const probes: SynProbe[] = [
  { id: "probe-1", claimId: "claim-1", riskiestAssumption: "r", falsification: "Run a pricing test" },
  { id: "probe-orphan", claimId: "claim-missing", riskiestAssumption: "r", falsification: "ignored" },
];

const input: BoardInput = { rooms, claims, probes };
const model = buildBoardModel(input);

/* ─── determinism ───────────────────────────────────────────────────────── */

const again = buildBoardModel({
  rooms: [...rooms].reverse(),
  claims: [...claims].reverse(),
  probes: [...probes].reverse(),
});
assert.deepEqual(again, model, "layout is deterministic regardless of input order");

/* ─── frames: one per room with claims, plus an unassigned bucket ───────── */

// room-a, room-b, and the unassigned bucket for the orphan claim.
assert.equal(model.frames.length, 3, "one frame per room with claims + unassigned");
const frameRooms = model.frames.map((f) => f.roomId);
// Known rooms are ordered by id (room-a before room-b), unassigned is last.
assert.deepEqual(frameRooms, ["room-a", "room-b", "__unassigned__"]);
assert.ok(model.frames[0].label.startsWith("THEME AREA: "), "frame carries an ALL-CAPS theme label");
assert.equal(model.frames[0].label, "THEME AREA: MARKET HYPOTHESIS");

/* ─── notes: every claim + only parent-backed probes become notes ──────── */

const claimNotes = model.notes.filter((n) => n.sourceType === "claim");
const probeNotes = model.notes.filter((n) => n.sourceType === "probe");
assert.equal(claimNotes.length, 4, "all claims become notes");
assert.equal(probeNotes.length, 1, "orphan probe (missing parent) is dropped");
assert.equal(probeNotes[0].kind, "VALIDATION_PROBE");
assert.equal(probeNotes[0].parentId, "claim:claim-1", "probe references its parent claim note");

// Claims are placed into their room's frame.
const room = new Map(model.notes.map((n) => [n.id, n.roomId]));
assert.equal(room.get("claim:claim-1"), "room-a");
assert.equal(room.get("claim:claim-3"), "room-b");
assert.equal(room.get("claim:claim-orphan"), "__unassigned__", "unknown-room claim falls into unassigned");

/* ─── connectors link probe → parent claim ──────────────────────────────── */

assert.equal(model.connectors.length, 1, "one connector for the single parent-backed probe");
assert.equal(model.connectors[0].fromId, "probe:probe-1");
assert.equal(model.connectors[0].toId, "claim:claim-1");

/* ─── geometry: notes sit inside their frame and never overlap ──────────── */

const frameById = new Map(model.frames.map((f) => [f.roomId, f]));
for (const note of model.notes) {
  const f = frameById.get(note.roomId)!;
  assert.ok(note.x >= f.x && note.x + note.w <= f.x + f.w, `note ${note.id} fits its frame horizontally`);
  assert.ok(note.y >= f.y && note.y + note.h <= f.y + f.h, `note ${note.id} fits its frame vertically`);
}

for (let i = 0; i < model.notes.length; i += 1) {
  for (let j = i + 1; j < model.notes.length; j += 1) {
    const a = model.notes[i];
    const b = model.notes[j];
    const overlap = a.x < b.x + b.w && a.x + b.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    assert.ok(!overlap, `notes ${a.id} and ${b.id} do not overlap`);
  }
}

// Bounds cover every frame.
for (const f of model.frames) {
  assert.ok(f.x + f.w <= model.bounds.w, "bounds width covers frame");
  assert.ok(f.y + f.h <= model.bounds.h, "bounds height covers frame");
}

// Note dimensions are the shared sticky size.
assert.equal(model.notes[0].w, NOTE_W);
assert.equal(model.notes[0].h, NOTE_H);

// Empty board is safe and produces no geometry.
const empty = buildBoardModel({ rooms: [], claims: [], probes: [] });
assert.equal(empty.notes.length, 0);
assert.equal(empty.frames.length, 0);
assert.ok(empty.bounds.w > 0 && empty.bounds.h > 0, "empty board still has positive bounds");

/* ─── the canvas screen wires the model + Ethos-token chrome ────────────── */

const canvas = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/board/StrategyCanvas.tsx"),
  "utf8",
);
assert.match(canvas, /buildBoardModel/, "StrategyCanvas builds its geometry from the pure model");
assert.match(canvas, /Strategy Canvas/, "canvas renders the mockup title");
assert.match(canvas, /translate\(/, "canvas uses a single transformed pan/zoom layer");

console.log("synthesis board model contract tests passed");
