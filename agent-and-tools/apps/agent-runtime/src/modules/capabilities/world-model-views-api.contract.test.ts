/**
 * Contract: the world-model view API surface (build planning + endpoint wiring).
 *
 * The build endpoint is the only way views ever come into existence — the design
 * is operator-triggered, so nothing else creates them. That makes two things
 * contractual:
 *  - the expansion from a request to a concrete build list ("auto", keyed kinds),
 *    which is pure and tested for real here
 *  - the endpoint wiring: reads stay open on archived capabilities (views are
 *    evidence), writes do not, and an unconfigured gateway fails loudly instead
 *    of enqueuing a build that can only fail
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planViewBuild, defaultBuildKinds } from "./world-model-view-specs";
import { ROLE_VIEW_KINDS } from "./world-model-views.types";

// ── build planning ───────────────────────────────────────────────────────────
{
  const auto = planViewBuild({});
  assert.ok(auto.ok, "an empty body plans the default build");
  assert.deepEqual(
    auto.views.map((v) => v.kind),
    defaultBuildKinds(),
    "omitted views means auto",
  );
  assert.equal(auto.views.length, 1 + ROLE_VIEW_KINDS.length, "auto builds the core plus every role view");
  assert.ok(
    auto.views.every((v) => v.domainKey === ""),
    "unkeyed kinds carry the empty domainKey the unique index expects",
  );

  const explicitAuto = planViewBuild({ views: "auto" });
  assert.ok(explicitAuto.ok && explicitAuto.views.length === auto.views.length, '"auto" matches the omitted case');

  const subset = planViewBuild({ views: ["testing", "security"] });
  assert.ok(subset.ok, "an explicit subset plans only those views");
  assert.deepEqual(subset.views, [
    { kind: "testing", domainKey: "" },
    { kind: "security", domainKey: "" },
  ]);
}

// Keyed kinds fan out over their keys — one view per key, not one view total.
{
  const domains = planViewBuild({ views: ["domain"], domainKeys: ["billing", "ledger"] });
  assert.ok(domains.ok, "domain views fan out over domainKeys");
  assert.deepEqual(domains.views, [
    { kind: "domain", domainKey: "billing" },
    { kind: "domain", domainKey: "ledger" },
  ]);

  const guide = planViewBuild({ views: ["task_guide"], task: "  add a migration  " });
  assert.ok(guide.ok, "a task guide is keyed by its task");
  assert.deepEqual(guide.views, [{ kind: "task_guide", domainKey: "add a migration" }], "the task key is trimmed");

  const mixed = planViewBuild({ views: ["core_summary", "domain"], domainKeys: ["billing"] });
  assert.ok(mixed.ok && mixed.views.length === 2, "keyed and unkeyed kinds can be planned together");
}

// A keyed kind with no key is a client error. Skipping it silently would return
// 202 with nothing built, which an operator cannot distinguish from in-flight.
{
  const noKeys = planViewBuild({ views: ["domain"] });
  assert.ok(!noKeys.ok, "a domain view without keys is rejected");
  assert.match(noKeys.error, /domainKeys/, "the error names the missing field");

  const noTask = planViewBuild({ views: ["task_guide"] });
  assert.ok(!noTask.ok && /task/.test(noTask.error), "a task guide without a task is rejected");

  const blankKeys = planViewBuild({ views: ["domain"], domainKeys: ["", "   "] });
  assert.ok(!blankKeys.ok, "blank keys do not count as keys");
}

// Bad input is rejected rather than coerced — an unknown kind has no spec, so a
// build would fail at the LLM call with a far less useful message.
{
  const empty = planViewBuild({ views: [] });
  assert.ok(!empty.ok, "an empty view list is rejected");

  const unknown = planViewBuild({ views: ["development", "wizardry"] });
  assert.ok(!unknown.ok && /wizardry/.test(unknown.error), "unknown kinds are named in the error");

  const notArray = planViewBuild({ views: "everything" });
  assert.ok(!notArray.ok, 'only "auto" is accepted as a string');
}

// Duplicate requests collapse. The row is unique on (capability, kind, key), so
// building the same view twice in one request is wasted LLM spend on a row that
// would immediately be overwritten.
{
  const dupes = planViewBuild({ views: ["testing", "testing", "domain", "domain"], domainKeys: ["billing", "billing"] });
  assert.ok(dupes.ok, "duplicates plan successfully");
  assert.deepEqual(dupes.views, [
    { kind: "testing", domainKey: "" },
    { kind: "domain", domainKey: "billing" },
  ], "each (kind, domainKey) is planned once");
}

// ── endpoint wiring ──────────────────────────────────────────────────────────
const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.controller.ts"), "utf8");
const routes = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.routes.ts"), "utf8");
const builder = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/world-model-view-builder.service.ts"), "utf8");

for (const [method, route] of [
  ["post", "/:id/world-model/views/build"],
  ["get", "/:id/world-model/views"],
  ["get", "/:id/world-model/views/:kind"],
  ["delete", "/:id/world-model/views/:kind"],
] as const) {
  assert.match(
    routes,
    new RegExp(`capabilityRoutes\\.${method}\\(\\s*"${route.replace(/[/:]/g, "\\$&")}"`),
    `${method.toUpperCase()} ${route} should be registered`,
  );
}

// Writes respect archival; reads do not. A view is evidence about a capability,
// and archiving one must not destroy the record of what it was.
assert.match(
  controller,
  /async buildWorldModelViews\(req: Request, res: Response\) \{\s*await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);/,
  "building views should reject archived capabilities first",
);
assert.match(
  controller,
  /async deleteWorldModelView\(req: Request, res: Response\) \{\s*await assertCapabilityMutable\(req\.params\.id, "Capability is archived; world-model maintenance is read-only\."\);/,
  "deleting a view should reject archived capabilities",
);
/** One handler's body, bounded by the next handler so negative assertions cannot bleed. */
function handlerBody(name: string): string {
  const start = controller.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `${name} should exist on the controller`);
  const next = controller.indexOf("\n  async ", start + 1);
  return controller.slice(start, next === -1 ? undefined : next);
}

for (const handler of ["listWorldModelViews", "getWorldModelView"] as const) {
  const body = handlerBody(handler);
  assert.match(
    body,
    /^async \w+\(req: Request, res: Response\) \{\s*assertCapabilityReadScope\(req\.user, req\.params\.id\);/,
    `${handler} should enforce the tenant read scope and nothing stricter`,
  );
  assert.doesNotMatch(body, /assertCapabilityMutable/, `${handler} should stay readable for archived capabilities`);
}

// An unconfigured gateway is a 409, not a 202. There is no heuristic fallback
// for a role view, so enqueuing the build would only produce FAILED rows.
assert.match(
  controller,
  /if \(!viewBuildEnabled\(\)\) \{[\s\S]*?res\.status\(409\)[\s\S]*?fixCommand:[\s\S]*?WORLD_MODEL_VIEWS_MODEL_ALIAS/,
  "an unconfigured builder should 409 with a fix command",
);
assert.match(
  controller,
  /if \(isBuildInFlight\(req\.params\.id\)\) \{[\s\S]*?res\.status\(409\)/,
  "a concurrent build should 409 rather than double-spend on the same capability",
);

// 202 + fire-and-forget: a full build is eight LLM calls, so the request must not
// hold the connection, and a rejected build must not surface as an unhandled one.
assert.match(
  controller,
  /void buildViews\(req\.params\.id, plan\.views\)\.catch\(\(\) => undefined\);\s*return res\.status\(202\)/,
  "builds should be fire-and-forget with a caught rejection and a 202",
);

// Staleness is derived at read time from the capability's current fingerprint,
// so a re-ground marks every view stale without touching a single view row.
assert.match(
  controller,
  /async listWorldModelViews[\s\S]*?stale: isViewStale\(v\.repoFingerprint, current\)/,
  "the manifest should derive stale from the live fingerprint",
);
assert.match(
  controller,
  /async getWorldModelView[\s\S]*?stale: isViewStale\(view\.repoFingerprint, worldModel\?\.repoFingerprint \?\? null\)/,
  "a single view read should derive stale the same way",
);

// ── single-flight ────────────────────────────────────────────────────────────
// The in-flight slot must be claimed synchronously. If anything is awaited first
// — the archive guard is the tempting place — two concurrent builds both find the
// map empty, then race each other's upserts on the same unique rows while paying
// twice at the gateway. The controller's isBuildInFlight pre-check cannot close
// this; it runs before buildViews is even entered.
{
  const start = builder.indexOf("export async function buildViews(");
  assert.notEqual(start, -1, "buildViews should exist");
  const body = builder.slice(start, builder.indexOf("\nexport function isBuildInFlight", start));
  // Comments are stripped: the prose explaining this rule naturally says "await".
  const beforeRun = body.slice(0, body.indexOf("const run = (async () =>")).replace(/\/\/[^\n]*/g, "");

  assert.doesNotMatch(beforeRun, /\bawait\b/, "nothing may be awaited before the in-flight slot is claimed");
  assert.match(beforeRun, /const existing = inflight\.get\(capabilityId\);\s*if \(existing\) return existing;/, "a live build should be joined, not restarted");
  assert.match(
    body,
    /const run = \(async \(\) => \{\s*await assertCapabilityWritable\(capabilityId\);/,
    "the archive guard should run inside the claimed run, not ahead of the claim",
  );
  assert.match(body, /inflight\.set\(capabilityId, run\);[\s\S]*?finally \{\s*inflight\.delete\(capabilityId\);/, "the slot must always be released");
}

// The builder is an infrastructure LLM call: gateway-bound, composer-exempt, and
// listed in the guard that enforces exactly that.
assert.match(builder, /\/v1\/chat\/completions/, "the builder should call the gateway chat endpoint");
assert.match(builder, /model_alias/, "the builder should tag its call with a model alias");
const guard = fs.readFileSync(path.join(process.cwd(), "../../../bin/check-llm-gateway-single-source.sh"), "utf8");
assert.match(
  guard,
  /world-model-view-builder\\?\.service\\?\.ts/,
  "the builder must be allowlisted in the single-gateway guard, not silently exempt",
);

console.log("world-model-views-api.contract.test.ts: OK");
