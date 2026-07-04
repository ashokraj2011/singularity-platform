import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { filterGalleryItems, normalizeGalleryResponse } from "./gallery-model";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/workflows/templates/gallery/page.tsx"), "utf8");

const normalized = normalizeGalleryResponse({
  generated_at: "2026-07-03T00:00:00.000Z",
  reference_only: "true",
  auth_required: false,
  message: 1234,
  intents: [
    {
      intent: "build_feature",
      name: "Build Feature",
      summary: "Deliver a feature",
      required_inputs: ["story", 42],
      sample_story: "As a user, I want exports.",
      default_agents: ["DEVELOPER", "QA"],
      default_model_alias: "copilot",
      runtime_preference: "runtime_bridge",
      governance_preset: "standard",
      runtime_requirement: "MCP runtime",
      template_count: "2",
      workflow_template: {
        template_id: "wf-1",
        display_name: "Governed delivery",
        workflow_type_key: "governed_delivery",
        capability_id: null,
      },
    },
    "bad",
    null,
  ],
});

assert.deepEqual(
  normalized,
  {
    generatedAt: "2026-07-03T00:00:00.000Z",
    items: [{
      id: "build_feature",
      label: "Build Feature",
      description: "Deliver a feature",
      requiredInputs: ["story", "42"],
      sampleStory: "As a user, I want exports.",
      defaultAgents: ["DEVELOPER", "QA"],
      defaultModelAlias: "copilot",
      runtimePreference: "runtime_bridge",
      governancePreset: "standard",
      runtimeRequirement: "MCP runtime",
      templateCount: 2,
      workflowTemplate: {
        id: "wf-1",
        name: "Governed delivery",
        description: undefined,
        workflowTypeKey: "governed_delivery",
        capabilityId: null,
      },
      templates: [],
    }],
    referenceOnly: true,
    authRequired: false,
    message: "1234",
  },
  "template gallery should normalize intent envelopes, aliases, booleans, and malformed rows",
);

assert.equal(
  normalizeGalleryResponse({ data: [{ key: "release", label: "Release Evidence" }] }).items[0].id,
  "release",
  "template gallery should accept data envelopes",
);

assert.deepEqual(
  normalizeGalleryResponse({ status: "error", message: "not a list" }).items,
  [],
  "template gallery should fail closed to an empty list for non-list envelopes",
);

assert.equal(filterGalleryItems(normalized.items, "developer").length, 1);
assert.equal(filterGalleryItems(normalized.items, "governed").length, 1);
assert.equal(filterGalleryItems(normalized.items, "does-not-match").length, 0);

assert.match(
  page,
  /return normalizeGalleryResponse\(parsed\);/,
  "workflow template gallery fetch should normalize parsed responses before rendering",
);

assert.match(
  page,
  /const items = useMemo\(\(\) => filterGalleryItems\(data\?\.items \?\? \[\], query\), \[data\?\.items, query\]\);/,
  "workflow template gallery page should use the shared filter helper over normalized rows",
);

assert.doesNotMatch(
  page,
  /return parsed as GalleryResponse|const rows = data\?\.items \?\? \[\]/,
  "workflow template gallery page should not cast raw responses or reimplement row filtering inline",
);

console.log("workflow template gallery normalization contract tests passed");
