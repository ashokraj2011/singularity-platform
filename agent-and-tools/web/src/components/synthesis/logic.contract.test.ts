import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CONTESTED_VAR,
  LIKELY_FALSE,
  isContested,
  isLikelyFalse,
  isUnbacked,
  computeMaturity,
  MATURITY_ORDER,
  timeAgo,
} from "./logic";

/* ─── consistency signals ───────────────────────────────────────────────── */

assert.equal(CONTESTED_VAR, 0.05);
assert.equal(LIKELY_FALSE, 0.35);

assert.ok(isContested({ disagreement: 0.06 } as never), "high variance is contested");
assert.ok(!isContested({ disagreement: 0.04 } as never), "low variance is not contested");
assert.ok(!isContested({} as never), "missing variance defaults to not contested");

assert.ok(isLikelyFalse({ mean: 0.2 } as never), "low posterior is likely false");
assert.ok(!isLikelyFalse({ mean: 0.6 } as never), "high posterior is not likely false");
assert.ok(!isLikelyFalse({} as never), "missing mean defaults to 0.5 (not likely false)");

assert.ok(isUnbacked({ estimateCount: 1 } as never), "one estimate is unbacked");
assert.ok(isUnbacked({ estimateCount: 0 } as never), "zero estimates is unbacked");
assert.ok(!isUnbacked({ estimateCount: 3 } as never), "several estimates is backed");

/* ─── maturity heuristic ────────────────────────────────────────────────── */

const seed = computeMaturity({ status: "DRAFT", workItemCount: 0 });
assert.equal(seed.label, "SEED", "empty draft is SEED");
assert.ok(seed.score >= 0 && seed.score <= 1, "score is normalized");

const mature = computeMaturity({ status: "ACTIVE", workItemCount: 20 });
assert.equal(mature.label, "MATURE", "active initiative with many items is MATURE");
assert.equal(mature.score, 1, "score caps at 1");

// monotonic: more work items never lowers the score
let prev = -1;
for (const n of [0, 1, 3, 5, 10, 50]) {
  const s = computeMaturity({ status: "ACTIVE", workItemCount: n }).score;
  assert.ok(s >= prev, "maturity score is monotonic in work-item count");
  prev = s;
}

// order list is a stable descending ranking used by the registry UI
assert.deepEqual(MATURITY_ORDER, ["MATURE", "DELIVERING", "SHAPING", "SEED"]);

/* ─── relative time ─────────────────────────────────────────────────────── */

const now = Date.parse("2024-01-01T12:00:00Z");
assert.equal(timeAgo(undefined, now), "—");
assert.equal(timeAgo("not-a-date", now), "—");
assert.equal(timeAgo("2024-01-01T11:59:30Z", now), "just now");
assert.equal(timeAgo("2024-01-01T11:30:00Z", now), "30m ago");
assert.equal(timeAgo("2024-01-01T09:00:00Z", now), "3h ago");
assert.equal(timeAgo("2023-12-30T12:00:00Z", now), "2d ago");

/* ─── nav wiring is scoped under /synthesis ─────────────────────────────── */

const shell = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/SynthesisShell.tsx"),
  "utf8",
);
const hrefs = [...shell.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
assert.ok(hrefs.length >= 12, "SynthesisShell should register the complete creative workspace");
for (const href of hrefs) {
  assert.ok(href.startsWith("/synthesis/"), `nav href ${href} must live under /synthesis`);
}
assert.match(shell, /label: "Idea Board"/, "the primary synthesis capture surface should be named Idea Board");
for (const phase of ["Orient", "Explore", "Decide", "Specify", "Govern"]) {
  assert.ok(shell.includes(`"${phase}"`), `Synthesis should expose the ${phase} phase`);
}
assert.match(shell, /"Online"/, "Synthesis shell should label browser connectivity as Online");
assert.doesNotMatch(shell, /"Synced"/, "Synthesis shell must not imply persistence sync from browser network status");
for (const surface of ["Journey Map", "Evidence Wiki", "System Diagrams", "Pseudocode"]) {
  assert.ok(shell.includes(surface), `Synthesis should expose ${surface}`);
}
assert.match(shell, /<aside/, "Synthesis should provide its dedicated workspace navigation");

const appShell = fs.readFileSync(
  path.join(process.cwd(), "src/components/AppShell.tsx"),
  "utf8",
);
assert.match(appShell, /FULL_BLEED_PREFIXES\s*=\s*\[[^\]]*synthesis/, "Synthesis should own the full viewport");

const synthesisIndex = fs.readFileSync(
  path.join(process.cwd(), "src/app/synthesis/page.tsx"),
  "utf8",
);
assert.doesNotMatch(synthesisIndex, /from ["']next\/navigation["'];?\s*\n.*redirect/, "Synthesis entry must not throw a server redirect below the client auth gate");
assert.match(synthesisIndex, /router\.replace\("\/synthesis\/studio"\)/, "Synthesis entry should navigate after the session gate renders");
const conversationalStudio = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/screens/ConversationalStudioScreen.tsx"),
  "utf8",
);
assert.match(conversationalStudio, /converse/, "Synthesis Studio should use the conductor endpoint");
assert.match(conversationalStudio, /Workspace pane/, "Synthesis Studio should expose the durable workspace pane");
assert.match(conversationalStudio, /Add source/, "Synthesis Studio should link users to source intake");
assert.match(conversationalStudio, /stream/, "Synthesis Studio should subscribe to the authenticated thread stream");
assert.match(conversationalStudio, /uploadSynthesisAttachment/, "Synthesis Studio should support direct in-thread source attachment");
assert.match(conversationalStudio, /kind === "ATTACHMENT"/, "Synthesis Studio should render attachment lifecycle messages");
assert.match(conversationalStudio, /kind === "CARD"/, "Synthesis Studio should render proposal card messages");

const synthesisHub = fs.readFileSync(
  path.join(process.cwd(), "src/app/synthesis/hub/page.tsx"),
  "utf8",
);
assert.match(synthesisHub, /One initiative belongs to one platform capability/, "Initiative creation should attach to exactly one platform capability");
assert.doesNotMatch(synthesisHub, /impactedCapabilityIds|supportingCapabilityIds|consumedCapabilityIds|proposedCapabilityIds|Capability map/, "Synthesis hub must not expose secondary capability mapping for initiatives");
assert.match(synthesisHub, /assignedCapability\?\.name/, "Synthesis hub should render the singular assigned capability, not a multi-capability map");

const synthesisTypes = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/types.ts"),
  "utf8",
);
const capabilityLinkType = synthesisTypes.match(/export interface SynCapabilityLink \{[\s\S]*?\n\}/)?.[0] ?? "";
assert.match(capabilityLinkType, /role:\s*"PRIMARY"/, "Synthesis capability links should be primary-only in the frontend contract");
assert.doesNotMatch(capabilityLinkType, /"IMPACTED"|"SUPPORTING"|"CONSUMES"|"PROPOSED"/, "Synthesis capability link types must not expose secondary initiative roles");
assert.match(synthesisTypes, /assignedCapability\?: \{ id: string; name: string \} \| null;/, "Synthesis project type should expose one assigned capability");

const legacyStudioIndex = fs.readFileSync(
  path.join(process.cwd(), "src/app/studio/page.tsx"),
  "utf8",
);
assert.match(legacyStudioIndex, /redirect\("\/synthesis\/hub"\)/, "Legacy /studio should redirect to Synthesis");

const legacyStudioProject = fs.readFileSync(
  path.join(process.cwd(), "src/app/studio/[projectId]/page.tsx"),
  "utf8",
);
assert.match(legacyStudioProject, /\/synthesis\/overview\?project=/, "Legacy /studio/:projectId should redirect to Synthesis overview");

const projectGeneration = fs.readFileSync(
  path.join(process.cwd(), "src/components/studio/ProjectGeneration.tsx"),
  "utf8",
);
assert.match(projectGeneration, /Rows inherit the initiative capability/, "Generation planning should inherit the initiative capability");
assert.match(projectGeneration, /\/studio\/projects\/\$\{projectId\}/, "Generation planning should load the initiative's assigned capability");
assert.doesNotMatch(projectGeneration, /\/lookup\/capabilities\?size=200/, "Generation planning must not expose an arbitrary target-capability picker");
assert.match(projectGeneration, /targetCapabilityId:\s*capabilityId/, "Generated rows should use the single initiative capability in the payload");

const nextConfig = fs.readFileSync(
  path.join(process.cwd(), "next.config.mjs"),
  "utf8",
);
assert.match(nextConfig, /source: "\/studio", destination: "\/synthesis\/hub"/, "Next config should issue an HTTP redirect for /studio");
assert.match(nextConfig, /source: "\/studio\/:projectId", destination: "\/synthesis\/overview\?project=:projectId"/, "Next config should issue an HTTP redirect for /studio/:projectId");

const ideaScreen = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/screens/IdeaWallScreen.tsx"),
  "utf8",
);
assert.match(ideaScreen, /IdeaBoardWorkspace/, "the Idea Board route should mount the durable board workspace");
assert.match(ideaScreen, /fullBleed=\{view === "board" \|\| view === "canvas"\}/, "the spatial canvas should use the full work area");
assert.match(ideaScreen, /FactVotingView/, "the Idea Board should expose fact review and voting");
assert.match(ideaScreen, /StrategyCanvas/, "the Idea Board should expose the freeform Strategy Canvas");
assert.match(ideaScreen, /setView\("canvas"\)/, "the Strategy Canvas should be a selectable workspace view");

const intakeScreen = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/screens/IntakeWorkspaceScreen.tsx"),
  "utf8",
);
assert.match(intakeScreen, /Upload document/, "source intake should expose a browser document upload mode");
assert.match(intakeScreen, /uploadStudioArtifact/, "source intake should use the authenticated multipart ingestion helper");
assert.match(intakeScreen, /\.pdf.*\.docx.*\.pptx.*\.xlsx/, "source intake should advertise the supported binary document formats");

const boardCanvas = fs.readFileSync(
  path.join(process.cwd(), "src/components/studio/BoardCanvas.tsx"),
  "utf8",
);
for (const capability of ["ReactFlow", "Synthesize", "Promote", "Connect", "Timeline"]) {
  assert.ok(boardCanvas.includes(capability), `Idea Board should expose ${capability}`);
}
for (const miroLikeCapability of ["NodeResizer", "BOARD_TEMPLATES", "Undo", "Redo", "Facilitation", "Dot voting", "Object details", "Find on board"]) {
  assert.ok(boardCanvas.includes(miroLikeCapability), `Idea Board should keep Miro-style capability: ${miroLikeCapability}`);
}
for (const deeperBoardCapability of ["RemoteCursorLayer", "CollaborationDrawer", "privateDrafts", "readFileAsDataUrl", "boardToSvg", "Reply or @mention", "Shape style"]) {
  assert.ok(boardCanvas.includes(deeperBoardCapability), `Idea Board should keep advanced board capability: ${deeperBoardCapability}`);
}

console.log("synthesis logic + nav contract tests passed");
