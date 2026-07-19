/**
 * Contract test for the WORLD_MODEL_VIEW layer.
 *
 * These layers carry the role-scoped views an agent reads. The guarantees:
 *  - the layer is DARK until views are supplied: no views means the exact layer
 *    set the composer produces today, byte for byte
 *  - one enum value serves all ten view kinds; the kind travels in the heading
 *    and the inclusion reason
 *  - priority 309 puts views after the capability-wide model and before anything
 *    task-specific, and the slice's ordering survives
 *  - a stale view is rendered with a note, never dropped
 *  - the composer does NOT re-filter what the slice already chose
 *
 * Run via:
 *   pnpm --filter @agentandtools/prompt-composer run test:contracts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("./compose.service") as typeof import("./compose.service");

type View = Parameters<typeof svc.renderWorldModelViewLayer>[0];

function view(over: Partial<View> = {}): View {
  return {
    kind: "development",
    title: "Development View",
    contentMd: "Start in src/index.ts.",
    ...over,
  } as View;
}

const CAP = 5000;

// ── rendering ────────────────────────────────────────────────────────────────
{
  const out = svc.renderWorldModelViewLayer(view(), CAP);
  assert.ok(out, "a view with content renders");
  assert.match(out, /^## Capability View — Development View \[development\]/, "the heading names the view and its kind");
  assert.match(out, /Start in src\/index\.ts\./, "the body is included");
  assert.doesNotMatch(out, /out of date/, "a fresh view carries no staleness note");
}

// A keyed view shows its key, so two domain views are distinguishable in a prompt.
{
  const out = svc.renderWorldModelViewLayer(view({ kind: "domain", title: "Billing", domainKey: "billing" }), CAP);
  assert.ok(out && out.includes("[domain: billing]"), "a keyed view shows its key in the heading");
}

// Stale views are rendered WITH A NOTE, not dropped. Grounding a commit behind
// beats none; dropping it would make a re-ground silently strip every agent's
// context until somebody noticed and rebuilt.
{
  const out = svc.renderWorldModelViewLayer(view({ stale: true }), CAP);
  assert.ok(out, "a stale view still renders");
  assert.match(out, /earlier revision of the repository/, "and says it may be out of date");
  assert.match(out, /Start in src\/index\.ts\./, "while keeping its content");
}

// Empty content produces no layer rather than a bare heading.
{
  for (const empty of ["", "   ", "\n\n"]) {
    assert.equal(svc.renderWorldModelViewLayer(view({ contentMd: empty }), CAP), null, "an empty view renders nothing");
  }
}

// The cap is enforced here, not left to whoever built the view.
{
  const long = "x".repeat(CAP * 3);
  const out = svc.renderWorldModelViewLayer(view({ contentMd: long }), CAP);
  assert.ok(out && out.length < long.length, "an oversized view is trimmed");
}

// ── layer assembly ───────────────────────────────────────────────────────────
{
  const layers: Parameters<typeof svc.appendWorldModelViewLayers>[0] = [];
  svc.appendWorldModelViewLayers(layers, [], CAP);
  assert.equal(layers.length, 0, "no views means no layers — the feature is dark until views exist");
}

{
  const layers: Parameters<typeof svc.appendWorldModelViewLayers>[0] = [];
  svc.appendWorldModelViewLayers(
    layers,
    [
      view({ kind: "core_summary", title: "Capability Core" }),
      view({ kind: "development", title: "Development View" }),
      view({ kind: "domain", title: "Billing", domainKey: "billing" }),
    ],
    CAP,
  );

  assert.equal(layers.length, 3, "one layer per view");
  assert.ok(layers.every((l) => l.layerType === "WORLD_MODEL_VIEW"), "all ten kinds share ONE layer type");
  assert.ok(layers.every((l) => l.priority === 309), "views sit at 309");
  assert.ok(layers.every((l) => !!l.layerHash), "every layer is hashed like its neighbours");

  // The kind rides the inclusion reason, which is what makes one enum value
  // enough — a new view kind needs no migration.
  assert.deepEqual(
    layers.map((l) => l.inclusionReason),
    ["world model view — core_summary", "world model view — development", "world model view — domain (billing)"],
  );

  // The slice already decided routing priority; the composer must not reorder.
  assert.deepEqual(
    layers.map((l) => (l.contentSnapshot.match(/\[([^\]]+)\]/) ?? [])[1]),
    ["core_summary", "development", "domain: billing"],
    "views keep the order the slice returned them in",
  );

  // Empty views are skipped without disturbing the rest.
  const mixed: Parameters<typeof svc.appendWorldModelViewLayers>[0] = [];
  svc.appendWorldModelViewLayers(mixed, [view({ contentMd: "" }), view({ kind: "testing", title: "Testing View" })], CAP);
  assert.equal(mixed.length, 1, "an empty view is skipped, its neighbour is not");
}

// ── wiring ───────────────────────────────────────────────────────────────────
const source = fs.readFileSync(path.join(process.cwd(), "src/modules/compose/compose.service.ts"), "utf8");
const schemas = fs.readFileSync(path.join(process.cwd(), "src/modules/compose/compose.schemas.ts"), "utf8");
const prisma = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/m10x_world_model_view_layers.sql"), "utf8");

// 309 must stay strictly between the capability-wide model and the task layers.
assert.match(source, /WORLD_MODEL_VIEW:\s+309,/, "the priority constant is 309");
const priorityOf = (name: string) => Number((source.match(new RegExp(`${name}:\\s+(\\d+),`)) ?? [])[1]);
assert.ok(
  priorityOf("CODE_WORLD_MODEL") < priorityOf("WORLD_MODEL_VIEW") && priorityOf("WORLD_MODEL_VIEW") < priorityOf("CODE_TASK_INTENT"),
  "views render after the capability-wide model and before task intent",
);

// Appended BEFORE the capsule-cache branch. These layers come from request input,
// not semantic retrieval, so they are not in a cached capsule's layer set — gating
// them behind a cache miss would drop them on every hot-path hit, which is the
// exact bug that had to be fixed for CODE_WORLD_MODEL.
const appendIdx = source.indexOf("appendWorldModelViewLayers(layers, input.worldModelViews");
const capsuleIdx = source.indexOf("Context Compiler cache lookup");
assert.ok(appendIdx > 0 && capsuleIdx > 0 && appendIdx < capsuleIdx, "view layers are appended before the capsule-cache branch, so they survive a cache hit");

// Guarded on length: an empty array is the normal state and must change nothing.
assert.match(source, /if \(input\.worldModelViews\?\.length\) \{/, "the call site guards on a non-empty array");

// worldModelViews is a SIBLING of worldModel — a capability with no repository
// can have views without having a world model at all.
assert.match(schemas, /worldModelViews: z\.array\(z\.object\(\{/, "the input accepts views");
assert.match(schemas, /worldModelViews: z\.array\([\s\S]*?\)\)\.optional\(\),/, "views are optional, so existing callers are unaffected");
assert.ok(
  schemas.indexOf("worldModelViews:") > schemas.indexOf("worldModel: z.object({"),
  "worldModelViews sits beside worldModel rather than inside it",
);

// The enum value is persisted on PromptAssemblyLayer, so the SQL must be applied
// before the code ships or every request carrying views fails its insert.
assert.match(prisma, /^\s*WORLD_MODEL_VIEW$/m, "the layer type is in the Prisma enum");
assert.match(migration, /ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'WORLD_MODEL_VIEW';/, "the migration adds the enum value idempotently");
assert.match(migration, /APPLY THIS BEFORE DEPLOYING THE CODE/, "the migration states its ordering requirement");

console.log("world-model-view-layers.contract.test.ts: OK");
