/**
 * Contract: the view build prompts are operator-configurable.
 *
 * The specs ARE the prompt — sections become required headings, min/maxWords
 * become the stated budget, emphasis becomes the per-view instruction. Hardcoding
 * them made "tune what a view says" a release cycle, which is the wrong loop for
 * prompt work.
 *
 * Everything here is about the override being SAFE to hand an operator: partial,
 * so nobody restates ten specs to change one number, and degrading rather than
 * throwing, because a typo in a prompt config must not stop a service booting.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_SPECS,
  parseViewSpecs,
  loadViewSpecsWithMeta,
  resetViewSpecsCache,
  viewSpec,
} from "./world-model-view-specs";

// ── partial merge ────────────────────────────────────────────────────────────
{
  const { specs, warnings } = parseViewSpecs({ testing: { maxWords: 4000 } }, "test");
  assert.equal(warnings.length, 0, "a clean override warns about nothing");
  assert.equal(specs.testing.maxWords, 4000, "the overridden field changes");
  assert.equal(specs.testing.minWords, DEFAULT_SPECS.testing.minWords, "untouched fields keep their default");
  assert.deepEqual(specs.testing.sections, DEFAULT_SPECS.testing.sections, "sections survive a caps-only override");
  assert.deepEqual(specs.development, DEFAULT_SPECS.development, "other kinds are untouched entirely");
}

{
  const { specs } = parseViewSpecs({ business: { sections: ["Only this"], emphasis: "Be terse." } }, "test");
  assert.deepEqual(specs.business.sections, ["Only this"]);
  assert.equal(specs.business.emphasis, "Be terse.");
  assert.equal(specs.business.maxWords, DEFAULT_SPECS.business.maxWords);
}

// ── refusing bad values without losing the rest ──────────────────────────────
{
  // A floor above the ceiling would tell the model to write both more and less
  // than a number. The pair is rejected together rather than half-applied.
  const { specs, warnings } = parseViewSpecs({ testing: { minWords: 9000, maxWords: 100 } }, "test");
  assert.equal(specs.testing.minWords, DEFAULT_SPECS.testing.minWords);
  assert.equal(specs.testing.maxWords, DEFAULT_SPECS.testing.maxWords);
  assert.ok(warnings.some((w) => /maxWords must exceed minWords/.test(w)));
}

{
  const { specs, warnings } = parseViewSpecs({ testing: { sections: [] } }, "test");
  assert.deepEqual(specs.testing.sections, DEFAULT_SPECS.testing.sections, "an empty section list is refused, not applied");
  assert.ok(warnings.some((w) => /sections override was empty/.test(w)));
}

{
  const { specs, warnings } = parseViewSpecs({ nonsense_kind: { maxWords: 10 }, testing: { maxWords: 4000 } }, "test");
  assert.ok(warnings.some((w) => /nonsense_kind/.test(w)), "an unknown kind is named");
  assert.equal(specs.testing.maxWords, 4000, "and does not stop the valid part applying");
}

// ── degradation ──────────────────────────────────────────────────────────────
{
  for (const bad of [[1, 2], "nonsense", 42] as unknown[]) {
    const result = parseViewSpecs(bad, "test");
    assert.equal(result.specs, DEFAULT_SPECS, "malformed config falls back to the built-in specs");
    assert.ok(result.warnings.length > 0, "and says so");
  }
  assert.equal(parseViewSpecs(null, "test").specs, DEFAULT_SPECS);
  assert.equal(parseViewSpecs(null, "test").warnings.length, 0, "absent config is the default, not an error");
}

// ── env loading ──────────────────────────────────────────────────────────────
{
  const original = process.env.WORLD_MODEL_VIEW_SPECS_JSON;
  try {
    resetViewSpecsCache();
    delete process.env.WORLD_MODEL_VIEW_SPECS_JSON;
    assert.equal(loadViewSpecsWithMeta().source, "default");
    assert.equal(viewSpec("testing").maxWords, DEFAULT_SPECS.testing.maxWords);

    process.env.WORLD_MODEL_VIEW_SPECS_JSON = JSON.stringify({ testing: { maxWords: 4000 } });
    resetViewSpecsCache();
    assert.equal(viewSpec("testing").maxWords, 4000, "viewSpec reads through the override");
    assert.equal(loadViewSpecsWithMeta().source, "WORLD_MODEL_VIEW_SPECS_JSON");

    // The cache key follows the value, so an edit is picked up without a restart
    // -- the whole point of moving this out of code.
    process.env.WORLD_MODEL_VIEW_SPECS_JSON = JSON.stringify({ testing: { maxWords: 5000 } });
    assert.equal(viewSpec("testing").maxWords, 5000, "changing the env re-reads the config");

    process.env.WORLD_MODEL_VIEW_SPECS_JSON = "{ not json";
    resetViewSpecsCache();
    const degraded = loadViewSpecsWithMeta();
    assert.equal(degraded.specs, DEFAULT_SPECS, "unparseable config degrades rather than throwing");
    assert.equal(degraded.source, "degraded-default");
    assert.ok(degraded.warnings.length > 0);
  } finally {
    if (original === undefined) delete process.env.WORLD_MODEL_VIEW_SPECS_JSON;
    else process.env.WORLD_MODEL_VIEW_SPECS_JSON = original;
    resetViewSpecsCache();
  }
}

// The defaults must survive their own merge, or an override of one field would
// silently reshape the spec it was merged onto.
{
  for (const kind of Object.keys(DEFAULT_SPECS)) {
    const { specs } = parseViewSpecs({ [kind]: {} }, "test");
    assert.deepEqual(specs[kind as keyof typeof specs], DEFAULT_SPECS[kind as keyof typeof DEFAULT_SPECS], `${kind} is unchanged by an empty override`);
  }
}

console.log("world-model-view-specs-config.contract.test.ts: OK");
