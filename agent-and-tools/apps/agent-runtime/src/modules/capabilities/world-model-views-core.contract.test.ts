/**
 * Contract: the layered world-model view core (specs → prompt → parse).
 *
 * These are the guarantees a stored view must keep, all provable without an LLM,
 * a gateway, or a database:
 *  - every kind has a spec, and a repo-less capability never gets repo-only grounding
 *  - the universal rules (no invention, provenance, no secrets, no pass-claims)
 *    reach the model verbatim
 *  - a view cannot self-certify provenance: "observed" with no source is downgraded
 *  - length caps are enforced at parse time, not left to the model
 */

import assert from "node:assert/strict";
import {
  WORLD_MODEL_VIEW_KINDS,
  ROLE_VIEW_KINDS,
  isWorldModelViewKind,
  requiresDomainKey,
  projectEvidence,
  isViewStale,
  type EvidenceEntry,
} from "./world-model-views.types";
import { viewSpec, allViewSpecs, defaultBuildKinds, selectorsFor } from "./world-model-view-specs";
import { buildViewMessages, buildViewSystemPrompt, renderGrounding, VIEW_INPUT_CAP, type GroundingPack } from "./world-model-view-prompts";
import { parseViewResponse, enforceProvenance, truncateToWords, extractJsonBlock } from "./world-model-view-parser";

function pack(over: Partial<GroundingPack> = {}): GroundingPack {
  return {
    capabilityName: "Billing",
    capabilityDescription: "Handles invoicing",
    repoBacked: true,
    sections: [{ selector: "worldModel", heading: "World model", body: "language: ts" }],
    ...over,
  };
}

// ── specs ────────────────────────────────────────────────────────────────────
{
  for (const kind of WORLD_MODEL_VIEW_KINDS) {
    const spec = viewSpec(kind);
    assert.equal(spec.kind, kind, `spec ${kind} self-identifies`);
    assert.ok(spec.sections.length >= 5, `${kind} has required sections`);
    assert.ok(spec.maxWords > spec.minWords, `${kind} has a sane word range`);
    assert.ok(spec.grounding.length > 0, `${kind} declares grounding`);
  }
  assert.equal(allViewSpecs().length, WORLD_MODEL_VIEW_KINDS.length, "every kind has a spec");
  assert.equal(ROLE_VIEW_KINDS.length, 7, "seven role views");
  assert.deepEqual(defaultBuildKinds().length, 8, "auto build = core + 7 role views");
  assert.ok(!defaultBuildKinds().includes("domain"), "auto build excludes on-demand kinds");
  assert.ok(!defaultBuildKinds().includes("task_guide"), "auto build excludes task guides");

  assert.equal(viewSpec("core_summary").maxWords, 1000, "core stays small — every agent loads it");
  assert.ok(requiresDomainKey("domain") && requiresDomainKey("task_guide"), "keyed kinds need a key");
  assert.ok(!requiresDomainKey("development"), "role views are not keyed");
  assert.ok(isWorldModelViewKind("testing") && !isWorldModelViewKind("nope"), "kind guard");

  // A capability with no repo must not be asked for code-derived grounding.
  const dev = viewSpec("development");
  const repoLess = selectorsFor(dev, { repoBacked: false });
  assert.ok(!repoLess.includes("codeSymbols"), "no code symbols without a repo");
  assert.ok(!repoLess.includes("architectureSlice"), "no architecture slice without a repo");
  assert.ok(!repoLess.includes("agentRules"), "no agent rules without a repo");
  assert.deepEqual(selectorsFor(dev, { repoBacked: true }), dev.grounding, "repo-backed keeps all grounding");
}

// ── prompts ──────────────────────────────────────────────────────────────────
{
  const spec = viewSpec("security");
  const sys = buildViewSystemPrompt(spec, pack());
  for (const rule of ["Do NOT invent", "observed", "inferred", "confidence", "Never output a secret value", "Never claim a test passes", "Absence of evidence"]) {
    assert.ok(sys.includes(rule), `universal rule present: ${rule}`);
  }
  for (const section of spec.sections) assert.ok(sys.includes(section), `required section in prompt: ${section}`);
  assert.ok(sys.includes(String(spec.maxWords)), "word cap stated to the model");
  assert.ok(sys.includes("STRICT JSON ONLY"), "output contract stated");
  assert.ok(sys.includes(spec.audience), "audience stated");

  const repoLess = buildViewSystemPrompt(spec, pack({ repoBacked: false }));
  assert.ok(repoLess.includes("no source repository"), "repo-less capabilities told to cite artifacts");

  const focused = buildViewSystemPrompt(viewSpec("task_guide"), pack({ focus: { kind: "task_guide", key: "add-endpoint" } }));
  assert.ok(focused.includes("add-endpoint"), "task focus reaches the prompt");

  const msgs = buildViewMessages(spec, pack());
  assert.equal(msgs.length, 2, "system + user");
  assert.equal(msgs[0].role, "system");
  assert.ok(msgs[1].content.startsWith("GROUNDING"), "grounding is the user turn");

  // Oversized grounding is truncated, never silently dropped whole.
  const huge = renderGrounding(pack({ sections: [{ selector: "codeSymbols", heading: "Symbols", body: "x".repeat(VIEW_INPUT_CAP * 2) }] }));
  assert.ok(huge.length < VIEW_INPUT_CAP * 2, "grounding is capped");
  assert.ok(huge.includes("Billing"), "capability header survives truncation");
}

// ── parser: provenance is not self-certified ─────────────────────────────────
{
  const entries: EvidenceEntry[] = [
    { claim: "cited", status: "observed", confidence: "high", locations: [{ path: "a.ts" }], artifacts: [], commit: null },
    { claim: "uncited", status: "observed", confidence: "high", locations: [], artifacts: [], commit: null },
    { claim: "artifact-cited", status: "observed", confidence: "medium", locations: [], artifacts: [{ artifactId: "k1" }], commit: null },
  ];
  const { entries: out, downgraded } = enforceProvenance(entries);
  assert.equal(downgraded, 1, "exactly the uncited claim is downgraded");
  assert.equal(out[0].status, "observed", "location-cited stays observed");
  assert.equal(out[2].status, "observed", "artifact-cited stays observed");
  assert.equal(out[1].status, "inferred", "uncited becomes inferred");
  assert.equal(out[1].confidence, "low", "and loses confidence");
}

// ── parser: extraction, caps, warnings ───────────────────────────────────────
{
  const spec = viewSpec("core_summary");
  assert.equal(extractJsonBlock('```json\n{"a":1}\n```').trim(), '{"a":1}', "fence stripped");
  assert.equal(extractJsonBlock('noise {"a":1} tail'), '{"a":1}', "braces sliced");

  assert.equal(truncateToWords("a b c", 10).truncated, false, "under cap untouched");
  const cut = truncateToWords("word ".repeat(50), 10);
  assert.ok(cut.truncated && cut.text.includes("[truncated"), "over cap is cut and flagged");

  assert.equal(parseViewResponse("", spec), null, "empty response → null");
  assert.equal(parseViewResponse("not json", spec), null, "unparseable → null");
  assert.equal(parseViewResponse('{"title":"x"}', spec), null, "no contentMd → null");

  const body = spec.sections.map((s) => `## ${s}\n${"word ".repeat(80)}`).join("\n");
  const parsed = parseViewResponse(
    JSON.stringify({
      title: "Capability Core",
      contentMd: body,
      evidence: [{ claim: "c", status: "observed", confidence: "high", locations: [{ path: "a.ts", startLine: 2, endLine: 9 }] }],
    }),
    spec,
    { commit: "abc123" },
  );
  assert.ok(parsed, "well-formed response parses");
  assert.ok(parsed!.contentHash.startsWith("sha256:"), "content hashed");
  assert.ok(parsed!.tokenEstimate > 0, "tokens estimated");
  assert.equal(parsed!.evidence[0].commit, "abc123", "build commit stamped onto evidence");
  assert.equal(parsed!.evidence[0].locations[0].startLine, 2, "locations preserved");
  assert.ok(!parsed!.warnings.some((w) => w.includes("missing sections")), "all sections present → no warning");

  const thin = parseViewResponse(JSON.stringify({ contentMd: "## What this capability is\nshort" }), spec);
  assert.ok(thin, "thin view still stored — partial grounding beats none");
  assert.ok(thin!.warnings.some((w) => w.includes("below")), "word floor warned");
  assert.ok(thin!.warnings.some((w) => w.includes("missing sections")), "missing sections warned");
}

// ── types: coercion + staleness ──────────────────────────────────────────────
{
  assert.deepEqual(projectEvidence("nope"), [], "non-array evidence → empty");
  assert.deepEqual(projectEvidence([{ status: "observed" }]), [], "entry without a claim is dropped");
  const coerced = projectEvidence([{ claim: "c", status: "bogus", confidence: "bogus", locations: [{ path: "a.ts", startLine: 1.7 }, { noPath: true }] }]);
  assert.equal(coerced[0].status, "inferred", "unknown status defaults to inferred (never over-claims)");
  assert.equal(coerced[0].confidence, "low", "unknown confidence defaults low");
  assert.equal(coerced[0].locations.length, 1, "location without a path dropped");
  assert.equal(coerced[0].locations[0].startLine, 1, "line floored to an integer");

  assert.equal(isViewStale("fp1", "fp2"), true, "differing fingerprints → stale");
  assert.equal(isViewStale("fp1", "fp1"), false, "same fingerprint → fresh");
  assert.equal(isViewStale(null, "fp1"), false, "unknown build fingerprint is not stale");
  assert.equal(isViewStale("fp1", null), false, "capability without a fingerprint is not stale");
}

console.log("world-model-views-core.contract.test.ts: OK");
