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
for (const surface of ["Journey Map", "Project Wiki", "Diagrams", "Pseudo-code"]) {
  assert.ok(shell.includes(surface), `Synthesis should expose ${surface}`);
}
assert.match(shell, /<aside/, "Synthesis should provide its dedicated workspace navigation");

const appShell = fs.readFileSync(
  path.join(process.cwd(), "src/components/AppShell.tsx"),
  "utf8",
);
assert.match(appShell, /FULL_BLEED_PREFIXES\s*=\s*\[[^\]]*synthesis/, "Synthesis should own the full viewport");

const ideaScreen = fs.readFileSync(
  path.join(process.cwd(), "src/components/synthesis/screens/IdeaWallScreen.tsx"),
  "utf8",
);
assert.match(ideaScreen, /IdeaBoardWorkspace/, "the Idea Board route should mount the durable board workspace");
assert.match(ideaScreen, /fullBleed=\{view === "board"\}/, "the spatial canvas should use the full work area");
assert.match(ideaScreen, /FactVotingView/, "the Idea Board should expose fact review and voting");

const boardCanvas = fs.readFileSync(
  path.join(process.cwd(), "src/components/studio/BoardCanvas.tsx"),
  "utf8",
);
for (const capability of ["ReactFlow", "Synthesize", "Promote", "Connect", "Timeline"]) {
  assert.ok(boardCanvas.includes(capability), `Idea Board should expose ${capability}`);
}

console.log("synthesis logic + nav contract tests passed");
