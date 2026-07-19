/**
 * View prompt construction — PURE, no I/O, fully unit-testable.
 *
 * Turns a ViewSpec + a grounding pack into the gateway chat messages. The
 * universal rules live here in one place: every claim carries provenance, no
 * fact is invented, missing evidence becomes an explicit unknown rather than a
 * confident guess. A world model that quietly hallucinates is worse than none —
 * an agent would act on it.
 *
 * Mirrors the proven bootstrap-phase3-distill prompt shape (strict JSON out, hard
 * input cap, temperature 0) so both distillation paths fail the same way.
 */

import type { ViewSpec } from "./world-model-view-specs";
import type { GroundingSelector } from "./world-model-view-specs";

/** Total grounding characters handed to the model for one view. */
export const VIEW_INPUT_CAP = 48_000;
/** Per-source cap so one huge README cannot crowd out the code symbols. */
export const VIEW_SECTION_CAP = 12_000;

export type GroundingPack = {
  capabilityName: string;
  capabilityDescription: string | null;
  repoBacked: boolean;
  /** Rendered grounding sections, keyed by the selector that produced them. */
  sections: Array<{ selector: GroundingSelector; heading: string; body: string }>;
  /** Present only for domain / task_guide builds. */
  focus?: { kind: "domain" | "task_guide"; key: string; description?: string };
};

const UNIVERSAL_RULES = [
  "RULES — these override any instinct to be helpful:",
  "1. Ground every statement in the GROUNDING section below. Do NOT invent facts, files, commands, or behaviour. If the grounding does not support a section, write \"Unknown — not evidenced in the provided grounding\" under that heading and move on.",
  "2. Tag every substantive claim as observed (read directly from the grounding) or inferred (concluded from it), and give it a confidence of high, medium, or low.",
  "3. Evidence: a claim about code cites file locations (path, and line numbers when the grounding provides them). A claim grounded in a document cites that artifact's id. An observed claim with neither is not observed — mark it inferred.",
  "4. Never output a secret value. Secret and credential NAMES only.",
  "5. Never claim a test passes, a deployment succeeds, or a rollback works. You are reading a repository, not running it. Report what exists.",
  "6. Absence of evidence is not evidence of absence. If you cannot find a control, a test, or a runbook, record it as an unknown — do not assert it is missing.",
].join("\n");

function outputContract(spec: ViewSpec): string {
  return [
    "Return STRICT JSON ONLY — no prose outside the JSON, no markdown fences:",
    "{",
    `  "title": "${spec.title}",`,
    '  "contentMd": "the view as GitHub-flavoured markdown, using exactly the required section headings as ## headings, in the given order",',
    '  "structured": { "optional": "machine-readable extras; omit if you have none" },',
    '  "evidence": [',
    '    { "claim": "the specific statement this supports",',
    '      "status": "observed" | "inferred",',
    '      "confidence": "high" | "medium" | "low",',
    '      "locations": [ { "path": "src/x.ts", "startLine": 10, "endLine": 24, "symbol": "optional" } ],',
    '      "artifacts": [ { "artifactId": "id-from-grounding", "title": "optional" } ] }',
    "  ]",
    "}",
  ].join("\n");
}

/** The system prompt for one view: audience, required sections, rules, contract. */
export function buildViewSystemPrompt(spec: ViewSpec, pack: GroundingPack): string {
  const parts: string[] = [
    `You are building the ${spec.title} of a capability world model — a durable grounding document that AI agents will load INSTEAD OF reading the whole repository.`,
    `Audience: ${spec.audience}. Write for that audience only; another view covers the rest.`,
    "",
    "REQUIRED SECTIONS — use these exact headings, in this order:",
    ...spec.sections.map((s, i) => `${i + 1}. ${s}`),
    "",
    `LENGTH: between ${spec.minWords} and ${spec.maxWords} words of markdown. Being under the cap by being specific is better than padding.`,
  ];
  if (spec.emphasis) parts.push("", `EMPHASIS: ${spec.emphasis}`);
  if (!pack.repoBacked) {
    parts.push(
      "",
      "NOTE: this capability has no source repository. Your grounding is its description, uploaded documents, and its child capabilities. Cite artifact ids, not file paths, and be explicit that code-level detail is unavailable.",
    );
  }
  if (pack.focus) {
    const label = pack.focus.kind === "domain" ? "domain" : "task";
    parts.push("", `FOCUS: this document covers only the ${label} "${pack.focus.key}".${pack.focus.description ? ` ${pack.focus.description}` : ""} Exclude anything outside it.`);
  }
  parts.push("", UNIVERSAL_RULES, "", outputContract(spec));
  return parts.join("\n");
}

function capSection(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= VIEW_SECTION_CAP) return trimmed;
  return `${trimmed.slice(0, VIEW_SECTION_CAP)}\n…[truncated]`;
}

/** Render the grounding pack, honouring the per-section and total caps. */
export function renderGrounding(pack: GroundingPack): string {
  const head = [
    `Capability: ${pack.capabilityName}`,
    pack.capabilityDescription ? `Description: ${pack.capabilityDescription}` : null,
    `Source repository available: ${pack.repoBacked ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: string[] = [head];
  let used = head.length;
  for (const section of pack.sections) {
    const body = capSection(section.body);
    if (!body) continue;
    const block = `\n\n## ${section.heading}\n${body}`;
    if (used + block.length > VIEW_INPUT_CAP) {
      blocks.push(`\n\n[grounding truncated — ${pack.sections.length} sections did not fit]`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("");
}

/** Gateway chat messages for one view build. */
export function buildViewMessages(spec: ViewSpec, pack: GroundingPack): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: buildViewSystemPrompt(spec, pack) },
    { role: "user", content: `GROUNDING\n\n${renderGrounding(pack)}` },
  ];
}
