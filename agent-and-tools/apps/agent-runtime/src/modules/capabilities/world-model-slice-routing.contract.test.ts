/**
 * Contract: role → view routing and the slice budget.
 *
 * This is the "loaded narrowly" half of the layered world model, and it is the
 * part that decides what an agent does NOT see. The guarantees:
 *  - every role resolves to something; an unknown role falls back rather than
 *    silently losing its grounding
 *  - core_summary is always first and is never evicted by the budget
 *  - a bad override degrades to the shipped table instead of taking grounding
 *    away from the whole platform
 *  - the slice endpoint treats "no views yet" and "parent capability with no
 *    world model" as normal, not as errors
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROLE_VIEWS,
  parseRoleViews,
  resolveRoleViews,
  loadRoleViews,
  loadRoleViewsWithMeta,
  resetRoleViewsCache,
} from "./world-model-role-views.config";
import { ROLE_VIEW_KINDS, isWorldModelViewKind } from "./world-model-views.types";

// ── the shipped table ────────────────────────────────────────────────────────
{
  for (const [role, kinds] of Object.entries(DEFAULT_ROLE_VIEWS.roles)) {
    assert.equal(role, role.toLowerCase(), `role "${role}" should be lowercase for lookup`);
    assert.ok(kinds.length > 0, `role "${role}" should route somewhere`);
    for (const kind of kinds) {
      assert.ok(isWorldModelViewKind(kind), `role "${role}" routes to a real kind`);
      assert.notEqual(kind, "core_summary", `role "${role}" should not list core_summary; it is always prepended`);
    }
  }

  // Every role view the builder can produce should be reachable by some role.
  // A view nobody loads is pure cost: an LLM call, a row, and staleness to track.
  const reachable = new Set(Object.values(DEFAULT_ROLE_VIEWS.roles).flat());
  for (const kind of ROLE_VIEW_KINDS) {
    assert.ok(reachable.has(kind), `no role loads the ${kind} view; it would be built and never read`);
  }

  assert.ok(DEFAULT_ROLE_VIEWS.roles[DEFAULT_ROLE_VIEWS.fallbackRole], "the fallback role should exist in the table");
}

// ── resolution ───────────────────────────────────────────────────────────────
{
  const dev = resolveRoleViews("developer", DEFAULT_ROLE_VIEWS);
  assert.ok(dev.matched, "a known role matches");
  assert.equal(dev.kinds[0], "core_summary", "core comes first");
  assert.deepEqual(dev.kinds, ["core_summary", "development"]);

  assert.deepEqual(resolveRoleViews("DEVELOPER", DEFAULT_ROLE_VIEWS).kinds, dev.kinds, "role matching is case-insensitive");
  assert.deepEqual(resolveRoleViews("  developer  ", DEFAULT_ROLE_VIEWS).kinds, dev.kinds, "role matching trims");

  const architect = resolveRoleViews("architect", DEFAULT_ROLE_VIEWS);
  assert.deepEqual(architect.kinds, ["core_summary", "architecture", "security"], "an architect reads structure and exposure together");

  const release = resolveRoleViews("release", DEFAULT_ROLE_VIEWS);
  assert.deepEqual(release.kinds, ["core_summary", "release", "testing", "operations"]);

  // A tester must not be handed the business case, and a business role must not
  // be handed the build commands. That separation is the point of the design.
  assert.ok(!resolveRoleViews("tester", DEFAULT_ROLE_VIEWS).kinds.includes("business"));
  assert.ok(!resolveRoleViews("product_owner", DEFAULT_ROLE_VIEWS).kinds.includes("development"));
}

// An unrecognised role falls back — roles arrive from workflow configs this
// service does not own, and silence would be worse than a sensible default.
{
  const unknown = resolveRoleViews("wizard", DEFAULT_ROLE_VIEWS);
  assert.ok(!unknown.matched, "an unknown role reports that it did not match");
  assert.deepEqual(unknown.kinds, ["core_summary", "development"], "unknown roles get the fallback");
  assert.match(unknown.reason, /wizard/, "the reason names the role that missed");

  for (const empty of [null, undefined, "", "   "]) {
    const none = resolveRoleViews(empty, DEFAULT_ROLE_VIEWS);
    assert.ok(!none.matched && none.kinds[0] === "core_summary", "an absent role still yields core plus the fallback");
  }
}

// ── overrides ────────────────────────────────────────────────────────────────
{
  const custom = parseRoleViews({ roles: { sre: ["operations", "security"], analyst: ["business"] }, fallbackRole: "sre" }, "test");
  assert.equal(custom.warnings.length, 0, "a clean override warns about nothing");
  assert.deepEqual(resolveRoleViews("sre", custom.config).kinds, ["core_summary", "operations", "security"]);
  assert.deepEqual(resolveRoleViews("developer", custom.config).kinds, ["core_summary", "operations", "security"], "an override replaces the table whole, so unlisted roles take the new fallback");

  // A typo costs one role its extra view, not the whole platform its grounding.
  const typo = parseRoleViews({ roles: { developer: ["development", "developement"] } }, "test");
  assert.deepEqual(resolveRoleViews("developer", typo.config).kinds, ["core_summary", "development"], "the unknown kind is dropped, the valid one survives");
  assert.ok(typo.warnings.some((w) => /developement/.test(w)), "the dropped kind is warned about by name");

  // core_summary listed explicitly must not be prepended twice.
  const doubled = parseRoleViews({ roles: { developer: ["core_summary", "development"] } }, "test");
  assert.deepEqual(resolveRoleViews("developer", doubled.config).kinds, ["core_summary", "development"], "core is not duplicated");

  const badFallback = parseRoleViews({ roles: { developer: ["development"] }, fallbackRole: "nobody" }, "test");
  assert.ok(badFallback.warnings.some((w) => /fallbackRole/.test(w)), "a fallback that resolves to nothing is warned about");
  assert.deepEqual(resolveRoleViews("wizard", badFallback.config).kinds, ["core_summary"], "and unknown roles then get core only");
}

// Malformed config degrades rather than throwing. This runs on the read path of
// every agent turn; a bad env var must not take grounding down platform-wide.
{
  for (const bad of [[1, 2, 3], "nonsense", 42] as unknown[]) {
    const result = parseRoleViews(bad, "test");
    assert.equal(result.config, DEFAULT_ROLE_VIEWS, "malformed config falls back to the shipped table");
    assert.ok(result.warnings.length > 0, "and says so");
  }
  assert.equal(parseRoleViews(null, "test").config, DEFAULT_ROLE_VIEWS, "absent config is the default, not an error");
  assert.equal(parseRoleViews(null, "test").warnings.length, 0, "absent config warns about nothing");

  const badRoles = parseRoleViews({ roles: { developer: "development" } }, "test");
  assert.ok(badRoles.warnings.some((w) => /array/.test(w)), "a non-array role list is warned about");
}

// Budget bounds are validated, not trusted — a maxViews of 0 would serve core
// only, and a tiny maxTotalChars would silently strip every role view.
{
  const ok = parseRoleViews({ budget: { maxViews: 5, maxTotalChars: 20000 } }, "test");
  assert.deepEqual(ok.config.budget, { maxViews: 5, maxTotalChars: 20000 });

  const bad = parseRoleViews({ budget: { maxViews: 0, maxTotalChars: 10 } }, "test");
  assert.deepEqual(bad.config.budget, DEFAULT_ROLE_VIEWS.budget, "out-of-range budgets keep the defaults");
  assert.equal(bad.warnings.length, 2, "each rejected budget field is warned about");
}

// ── env loading + cache ──────────────────────────────────────────────────────
{
  const original = process.env.WORLD_MODEL_ROLE_VIEWS_JSON;
  try {
    resetRoleViewsCache();
    delete process.env.WORLD_MODEL_ROLE_VIEWS_JSON;
    assert.equal(loadRoleViews(), DEFAULT_ROLE_VIEWS, "no env means the shipped table");

    process.env.WORLD_MODEL_ROLE_VIEWS_JSON = JSON.stringify({ roles: { developer: ["testing"] } });
    resetRoleViewsCache();
    assert.deepEqual(resolveRoleViews("developer", loadRoleViews()).kinds, ["core_summary", "testing"], "an inline override is picked up");

    // The cache key follows the env value, so a change is seen without a restart.
    process.env.WORLD_MODEL_ROLE_VIEWS_JSON = JSON.stringify({ roles: { developer: ["security"] } });
    assert.deepEqual(resolveRoleViews("developer", loadRoleViews()).kinds, ["core_summary", "security"], "changing the env re-reads the config");

    process.env.WORLD_MODEL_ROLE_VIEWS_JSON = "{ this is not json";
    resetRoleViewsCache();
    const degraded = loadRoleViewsWithMeta();
    assert.equal(degraded.config, DEFAULT_ROLE_VIEWS, "unparseable env degrades to the shipped table");
    assert.equal(degraded.source, "degraded-default");
  } finally {
    if (original === undefined) delete process.env.WORLD_MODEL_ROLE_VIEWS_JSON;
    else process.env.WORLD_MODEL_ROLE_VIEWS_JSON = original;
    resetRoleViewsCache();
  }
}

// ── slice service + endpoint wiring ──────────────────────────────────────────
const slice = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/world-model-slice.service.ts"), "utf8");
const controller = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.controller.ts"), "utf8");
const routes = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.routes.ts"), "utf8");

// Stale views are served, flagged. Dropping them would make a re-ground silently
// strip every agent's grounding until someone noticed and rebuilt.
assert.match(slice, /stale: !!currentFingerprint && !!doc\.repoFingerprint && doc\.repoFingerprint !== currentFingerprint/, "staleness is computed against the live fingerprint");
assert.doesNotMatch(slice, /filter\([^)]*!\w+\.stale/, "stale views must not be filtered out of the slice");

// Only READY rows reach a prompt: PENDING has no content, FAILED has only an error.
assert.match(slice, /status: "READY"/, "the slice query should select only READY views");

// core_summary is exempt from eviction — it is the smallest view and the one
// that makes the rest interpretable.
assert.match(slice, /const exempt = view\.kind === "core_summary";/, "core should be budget-exempt");
assert.match(slice, /if \(!exempt && kept\.length >= budget\.maxViews\)/, "the count cap should skip the exempt view");
assert.match(slice, /if \(!exempt && next > budget\.maxTotalChars\)/, "the char cap should skip the exempt view");
assert.match(slice, /dropped\.push\(\{ kind: view\.kind, domainKey: view\.domainKey, reason:/, "evictions are reported, not silent");

// Routing order must survive into the prompt, so results are ordered by what was
// wanted rather than by whatever order the database returned.
assert.match(slice, /for \(const want of wanted\) \{[\s\S]*?byKey\.get\(viewKey\(want\.kind, want\.domainKey\)\)/, "views are ordered by routing priority");

// The map must be built and read through the SAME key helper. Build it with one
// separator and read it with another and every lookup misses, which surfaces as
// an empty slice — indistinguishable from "nobody has built views yet".
assert.match(slice, /new Map\(rows\.map\(\(row\) => \[viewKey\(row\.kind, row\.domainKey\), projectViewDoc\(row\)\]\)\)/, "the lookup map is keyed by viewKey");
assert.equal((slice.match(/viewKey\(/g) ?? []).length, 2, "both sides of the lookup go through viewKey, with no hand-rolled key");

// A literal U+0000 in source is invisible in review and makes grep treat the file
// as binary, so a separator typo here would be nearly unfindable. The key helper
// spells it as an escape; assert no source file smuggles in a raw one.
for (const [name, source] of [
  ["world-model-slice.service.ts", slice],
  ["world-model-views.types.ts", fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/world-model-views.types.ts"), "utf8")],
  ["world-model-view-specs.ts", fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/world-model-view-specs.ts"), "utf8")],
] as const) {
  assert.ok(!source.includes(String.fromCharCode(0)), `${name} should not contain a literal NUL byte; write \\u0000 instead`);
}

// A parent capability with views but no world model is a valid slice; "no views
// built yet" is the normal state and must not be an error.
assert.match(
  controller,
  /async getWorldModelSliceForRole[\s\S]*?if \(!slice\.worldModel && slice\.views\.length === 0\) \{[\s\S]*?res\.status\(404\)/,
  "the slice should 404 only when there is neither a world model nor any views",
);
assert.match(controller, /async getWorldModelSliceForRole\(req: Request, res: Response\) \{\s*assertCapabilityReadScope\(req\.user, req\.params\.id\);/, "the slice is a tenant-scoped read");
assert.match(routes, /capabilityRoutes\.get\(\s*"\/:id\/world-model\/slice"/, "GET /:id/world-model/slice should be registered");

console.log("world-model-slice-routing.contract.test.ts: OK");
