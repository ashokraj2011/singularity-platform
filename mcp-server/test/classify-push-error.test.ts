/**
 * M70.8 — Verify classifyPushError + fixCommandsForPushBlock produce the
 * right diagnostic for each shape of push failure we see in production.
 *
 * Particularly the GitHub-specific "Permission to X/Y denied to Z" case,
 * which used to fall through to the generic GIT_PUSH_REJECTED bucket
 * and tell operators to "inspect the remote rejection" — actively
 * unhelpful when the actual fix is "edit your PAT scope."
 */
import { describe, expect, it, beforeAll } from "vitest";

let classifyPushError: (msg: string) => string;
let fixCommandsForPushBlock: (code: string, remote: string) => string[];

beforeAll(async () => {
  // config module needs MCP_BEARER_TOKEN to load; satisfy it.
  process.env.MCP_BEARER_TOKEN ??= "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL ??= "http://127.0.0.1:1";
  const mod = await import("../src/workspace/git-workspace");
  classifyPushError = mod.classifyPushError;
  fixCommandsForPushBlock = mod.fixCommandsForPushBlock;
});

describe("M70.8 — push error classifier", () => {
  describe("GIT_AUTH_INSUFFICIENT_SCOPE", () => {
    it("detects the GitHub 'Permission to X/Y denied to Z' shape", () => {
      const err = [
        "Command failed: git push --dry-run -u origin sg/foo/bar",
        "remote: Permission to example-org/RuleEngine.git denied to example-org.",
        "fatal: unable to access 'https://github.com/example-org/RuleEngine.git/': The requested URL returned error: 403",
      ].join("\n");
      expect(classifyPushError(err)).toBe("GIT_AUTH_INSUFFICIENT_SCOPE");
    });

    it("detects bare HTTP 403 from github.com", () => {
      const err = "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 403";
      expect(classifyPushError(err)).toBe("GIT_AUTH_INSUFFICIENT_SCOPE");
    });

    it("detects 'write access ... not granted' phrasing", () => {
      expect(
        classifyPushError("remote: Write access to the repository is not granted."),
      ).toBe("GIT_AUTH_INSUFFICIENT_SCOPE");
    });

    it("fix commands point at the PAT settings page, not a config wizard", () => {
      const cmds = fixCommandsForPushBlock("GIT_AUTH_INSUFFICIENT_SCOPE", "origin");
      const blob = cmds.join("\n");
      expect(blob).toMatch(/Contents:\s*Write|Contents = Read and write/i);
      expect(blob).toMatch(/github\.com\/settings\/tokens/);
      // Crucially, NOT the generic "inspect the remote rejection" line.
      expect(blob).not.toMatch(/inspect the remote rejection/i);
    });
  });

  describe("GIT_AUTH_MISSING (no token at all)", () => {
    it("'could not read Username for ...'", () => {
      expect(
        classifyPushError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
      ).toBe("GIT_AUTH_MISSING");
    });

    it("'authentication failed'", () => {
      expect(
        classifyPushError("remote: HTTP Basic: Access denied. The provided password or token is incorrect.\nfatal: Authentication failed"),
      ).toBe("GIT_AUTH_MISSING");
    });
  });

  describe("GIT_PUSH_REJECTED (the real catch-all)", () => {
    it("non-fast-forward push", () => {
      expect(
        classifyPushError("! [rejected]        main -> main (non-fast-forward)"),
      ).toBe("GIT_PUSH_REJECTED");
    });

    it("hook failure", () => {
      expect(
        classifyPushError("remote: pre-receive hook declined\nremote: error: GH013: Repository rule violations found for refs/heads/main"),
      ).toBe("GIT_PUSH_REJECTED");
    });
  });

  // M99 S1.4 — discrete codes split out of the generic GIT_PUSH_REJECTED /
  // GIT_AUTH_INSUFFICIENT_SCOPE buckets.
  describe("M99 S1.4 — discrete push-failure codes", () => {
    it("GH006 protected-branch routes to GIT_BRANCH_PROTECTED (not auth-scope)", () => {
      expect(
        classifyPushError("remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: At least 1 approving review is required."),
      ).toBe("GIT_BRANCH_PROTECTED");
    });

    it("'protected branch' phrasing → GIT_BRANCH_PROTECTED", () => {
      expect(
        classifyPushError("remote: Cannot push to this protected branch"),
      ).toBe("GIT_BRANCH_PROTECTED");
    });

    it("missing upstream → GIT_NO_UPSTREAM", () => {
      expect(
        classifyPushError("fatal: The current branch wi/RULE-1 has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin wi/RULE-1"),
      ).toBe("GIT_NO_UPSTREAM");
    });

    it("unrelated histories → GIT_REMOTE_MISMATCH", () => {
      expect(
        classifyPushError("fatal: refusing to merge unrelated histories"),
      ).toBe("GIT_REMOTE_MISMATCH");
    });

    it("regression guard: non-fast-forward 'remote contains work' stays GIT_PUSH_REJECTED", () => {
      expect(
        classifyPushError("hint: Updates were rejected because the remote contains work that you do\nhint: not have locally."),
      ).toBe("GIT_PUSH_REJECTED");
    });

    it("regression guard: bare GH013 rule-violation hook stays GIT_PUSH_REJECTED", () => {
      expect(
        classifyPushError("remote: pre-receive hook declined\nremote: error: GH013: Repository rule violations found"),
      ).toBe("GIT_PUSH_REJECTED");
    });

    it("fix commands: GIT_BRANCH_PROTECTED suggests a PR, not a token edit", () => {
      const blob = fixCommandsForPushBlock("GIT_BRANCH_PROTECTED", "origin").join("\n");
      expect(blob).toMatch(/pull request|feature branch/i);
      expect(blob).not.toMatch(/Contents:\s*Write/i);
    });

    it("fix commands: GIT_NO_UPSTREAM suggests push -u", () => {
      const blob = fixCommandsForPushBlock("GIT_NO_UPSTREAM", "origin").join("\n");
      expect(blob).toMatch(/push -u origin/);
    });

    it("fix commands: GIT_REMOTE_MISMATCH suggests checking the remote URL", () => {
      const blob = fixCommandsForPushBlock("GIT_REMOTE_MISMATCH", "origin").join("\n");
      expect(blob).toMatch(/remote -v|set-url/);
    });
  });
});
