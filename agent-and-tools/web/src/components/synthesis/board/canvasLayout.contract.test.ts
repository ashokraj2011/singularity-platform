import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EMPTY_DOC,
  mergeNotePositions,
  serializeObjects,
  toSavePayload,
  initHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  type CanvasDoc,
  type CanvasObject,
} from "./canvasLayout";

/* ─── mergeNotePositions: saved overrides win, stale entries dropped ─────── */

const defaults = [
  { id: "claim:a", x: 10, y: 10 },
  { id: "claim:b", x: 20, y: 20 },
];

// No saved layout → every note keeps its deterministic default.
assert.deepEqual(mergeNotePositions(defaults, null), {
  "claim:a": { x: 10, y: 10 },
  "claim:b": { x: 20, y: 20 },
});

// A saved override wins; notes without an override keep their default.
assert.deepEqual(mergeNotePositions(defaults, { "claim:a": { x: 99, y: 99 } }), {
  "claim:a": { x: 99, y: 99 },
  "claim:b": { x: 20, y: 20 },
});

// A saved position for a note that no longer exists is dropped (not carried forward).
const merged = mergeNotePositions(defaults, { "claim:gone": { x: 1, y: 1 } });
assert.ok(!("claim:gone" in merged), "stale override for a deleted note is dropped");

/* ─── serializeObjects: transient image url is never persisted ──────────── */

const objects: CanvasObject[] = [
  { id: "t1", type: "text", x: 0, y: 0, text: "hi" },
  { id: "i1", type: "image", x: 5, y: 5, storageKey: "k", bucket: "b", url: "https://signed/expires" },
];
const serialized = serializeObjects(objects);
const img = serialized.find((o) => o.type === "image")!;
assert.ok(!("url" in img), "image url is stripped before persisting");
assert.equal((img as { storageKey: string }).storageKey, "k", "durable descriptor is kept");

const payload = toSavePayload({ positions: { "claim:a": { x: 1, y: 2 } }, objects }, { x: 3, y: 4, z: 0.5 });
assert.deepEqual(payload.viewport, { x: 3, y: 4, z: 0.5 });
assert.ok(!("url" in payload.objects.find((o) => o.type === "image")!));

/* ─── history: undo / redo semantics ────────────────────────────────────── */

const d0: CanvasDoc = EMPTY_DOC;
const d1: CanvasDoc = { positions: { "claim:a": { x: 1, y: 1 } }, objects: [] };
const d2: CanvasDoc = { positions: { "claim:a": { x: 2, y: 2 } }, objects: [] };

let h = initHistory(d0);
assert.equal(canUndo(h), false, "nothing to undo initially");
assert.equal(canRedo(h), false);

h = pushHistory(h, d1);
h = pushHistory(h, d2);
assert.equal(h.present, d2);
assert.equal(canUndo(h), true);

h = undo(h);
assert.equal(h.present, d1, "undo steps back one commit");
assert.equal(canRedo(h), true);

h = undo(h);
assert.equal(h.present, d0, "undo steps back to the origin");
assert.equal(canUndo(h), false);

h = redo(h);
assert.equal(h.present, d1, "redo steps forward");

// A fresh commit after an undo clears the redo stack.
h = pushHistory(h, d2);
assert.equal(canRedo(h), false, "committing after undo clears the redo future");

// Pushing an identical present is a no-op (no spurious history entry).
const same = pushHistory(h, h.present);
assert.equal(same, h, "pushing the current present is a no-op");

// History is bounded so long sessions can't grow without limit.
let bounded = initHistory<number>(0);
for (let i = 1; i <= 200; i += 1) bounded = pushHistory(bounded, i, 60);
assert.ok(bounded.past.length <= 60, "undo history is capped");
assert.equal(bounded.present, 200);

/* ─── the canvas screen actually wires persistence + the pure helpers ───── */

const canvasSrc = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/board/StrategyCanvas.tsx"),
  "utf8",
);
assert.match(canvasSrc, /useCanvasLayout/, "canvas loads the persisted per-user layout");
assert.match(canvasSrc, /saveCanvasLayout/, "canvas saves layout changes back to the server");
assert.match(canvasSrc, /mergeNotePositions/, "canvas seeds positions via the pure merge helper");
assert.match(canvasSrc, /pushHistory|initHistory/, "canvas drives undo/redo via the history helpers");

const hooksSrc = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/hooks/useSynthesis.ts"),
  "utf8",
);
assert.match(hooksSrc, /canvas-layout/, "hooks target the /canvas-layout endpoint");
assert.match(hooksSrc, /uploadCanvasImage/, "hooks expose the image upload used by the upload tool");

console.log("synthesis canvas layout contract tests passed");
