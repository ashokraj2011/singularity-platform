import assert from "node:assert/strict";
import {
  learningWorkerRunSchema,
  reviewBootstrapSchema,
} from "./capability.schemas";

assert.equal(reviewBootstrapSchema.safeParse({
  approveGroupKeys: ["domain"],
  rejectGroupKeys: ["domain"],
  activateAgentTemplateIds: [],
}).success, false);

assert.equal(learningWorkerRunSchema.safeParse({
  approveGroupKeys: ["architecture"],
  rejectGroupKeys: ["architecture"],
  activateAgentTemplateIds: [],
}).success, false);

assert.equal(reviewBootstrapSchema.safeParse({
  approveGroupKeys: ["domain"],
  rejectGroupKeys: ["testing"],
  activateAgentTemplateIds: [],
}).success, true);

console.log("capability review schema contract tests passed");
