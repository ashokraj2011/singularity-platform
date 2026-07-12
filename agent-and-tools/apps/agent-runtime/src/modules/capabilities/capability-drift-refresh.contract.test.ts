import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const svc = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

// A drift-triggered refreshRepositoryProfileLearning re-derives language/build +
// re-embeds inventory/architecture, then stamps refreshedAt/lastAutoRefreshAt. It
// must ALSO refresh the DISTILLED world model, backfill KNOWLEDGE embeddings, and
// re-index CODE — otherwise the row presents as "refreshed" while those stay
// stale (the reported gap). Assert those calls exist within the function body.
const refreshIdx = svc.indexOf("export async function refreshRepositoryProfileLearning");
assert.ok(refreshIdx > 0, "refreshRepositoryProfileLearning must exist");

const distillIdx = svc.indexOf("distillAndUpsertWorldModel(capabilityId)", refreshIdx);
const reembedIdx = svc.indexOf('reembedCapability(capabilityId, { kinds: ["knowledge"] })', refreshIdx);
const codeIdx = svc.indexOf("triggerCentralCodeGrounding(capabilityId)", refreshIdx);

assert.ok(distillIdx > refreshIdx, "drift refresh must re-run world-model distillation (distillAndUpsertWorldModel)");
assert.ok(reembedIdx > refreshIdx, "drift refresh must backfill knowledge embeddings (reembedCapability kinds:[knowledge])");
assert.ok(codeIdx > refreshIdx, "drift refresh must re-index code centrally (triggerCentralCodeGrounding)");

// Best-effort: the distillation + re-embed steps are wrapped so a failure adds a
// warning and never fails the refresh.
const window = svc.slice(distillIdx, codeIdx + 200);
assert.match(window, /catch \(err\)[\s\S]*?warnings\.push/, "the heavy refresh steps must be best-effort (catch → warning)");

console.log("agent-runtime drift-refresh completeness contract tests passed");
