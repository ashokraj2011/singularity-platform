/**
 * M47.B — apply_patch should give the agent actionable error messages
 * instead of git's opaque "corrupt patch at line N".
 *
 * Two layers:
 *   1. validatePatchHunkArithmetic — pure pre-flight check on @@ counts
 *   2. enrichGitApplyError — adds surrounding context + suggestion when
 *      git apply's own check fails
 */
import { describe, expect, it } from "vitest";
import { validatePatchHunkArithmetic } from "../src/tools/fs-git";

describe("M47.B validatePatchHunkArithmetic", () => {
  it("returns null for a well-formed minimal patch", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      " line one",
      " line two",
      "+line three",
      "",
    ].join("\n");
    expect(validatePatchHunkArithmetic(patch)).toBeNull();
  });

  it("returns null when @@ header uses the implicit ,1 count", () => {
    // @@ -5 +5 @@ is shorthand for @@ -5,1 +5,1 @@
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    expect(validatePatchHunkArithmetic(patch)).toBeNull();
  });

  it("flags a hunk whose -count is too low for the body", () => {
    // Claim 2 source-side lines but body has 1 context + 2 removals = 3
    const bad = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,1 @@",
      " ctx",
      "-rm1",
      "-rm2",
      "",
    ].join("\n");
    const issue = validatePatchHunkArithmetic(bad);
    expect(issue).toMatch(/declares 2 source-side line/);
    expect(issue).toMatch(/has 3 context\+removal/);
  });

  it("flags a hunk whose +count is too low for the body (the RuleEngine failure shape)", () => {
    // Mirrors `@@ -192,4 +192,164 @@` where the body has 165 add+ctx lines.
    const body = ["+add1", "+add2", "+add3"]; // claim 1 but body has 3
    const bad = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,1 @@",
      " ctx",
      ...body,
      "",
    ].join("\n");
    const issue = validatePatchHunkArithmetic(bad);
    expect(issue).toMatch(/declares 1 destination-side line/);
    expect(issue).toMatch(/has 4 context\+addition/);
  });

  it("validates each hunk independently when there are multiple", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,1 @@",
      " ctx",
      "@@ -5,2 +5,1 @@",
      " ctxA",
      "-rm",
      "",
    ].join("\n");
    expect(validatePatchHunkArithmetic(patch)).toBeNull();
  });
});
