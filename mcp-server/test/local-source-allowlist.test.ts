import { describe, it, expect, beforeAll } from "vitest";

// #23 — localSourceRootAllowed gates `local`/filesystem sources to an allowlist of
// root prefixes. config parses MCP_ALLOWED_LOCAL_SOURCE_ROOTS once at import, so
// set it BEFORE importing the module under test.
let localSourceRootAllowed: (p: string) => boolean;

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN ??= "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL ??= "mock";
  process.env.MCP_ALLOWED_LOCAL_SOURCE_ROOTS = "/srv/repos, /data/src";
  localSourceRootAllowed = (await import("../src/workspace/source-materializer")).localSourceRootAllowed;
});

describe("localSourceRootAllowed (allowlist set)", () => {
  it("allows an exact allowed root", () => {
    expect(localSourceRootAllowed("/srv/repos")).toBe(true);
  });
  it("allows a path under an allowed root", () => {
    expect(localSourceRootAllowed("/srv/repos/my-project")).toBe(true);
  });
  it("allows a path under the second allowed root", () => {
    expect(localSourceRootAllowed("/data/src/x")).toBe(true);
  });
  it("rejects a sibling that only shares a prefix (anti-bypass)", () => {
    // The `+ path.sep` guard means '/srv/repos-evil' must NOT match root '/srv/repos'.
    expect(localSourceRootAllowed("/srv/repos-evil")).toBe(false);
  });
  it("rejects a path outside every allowed root", () => {
    expect(localSourceRootAllowed("/etc/passwd")).toBe(false);
    expect(localSourceRootAllowed("/root/.ssh")).toBe(false);
  });
});
