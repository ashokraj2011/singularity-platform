import { describe, expect, it } from "vitest";

import { readUpstreamJsonObject, upstreamSnippet } from "../src/engine/upstream-json";

describe("audit-governance upstream JSON helper", () => {
  it("accepts JSON objects", async () => {
    const out = await readUpstreamJsonObject(new Response('{"ok": true}', { status: 200 }), "unit upstream");
    expect(out).toEqual({ ok: true });
  });

  it("rejects invalid JSON with a body snippet", async () => {
    await expect(
      readUpstreamJsonObject(new Response("Internal Server Error", { status: 200 }), "unit upstream"),
    ).rejects.toThrow(/unit upstream returned invalid JSON \(200\).*Internal Server Error/);
  });

  it("rejects non-object JSON envelopes", async () => {
    await expect(
      readUpstreamJsonObject(new Response("[1,2,3]", { status: 200 }), "array upstream"),
    ).rejects.toThrow(/array upstream returned invalid JSON object \(200\)/);
  });

  it("compacts snippets", () => {
    expect(upstreamSnippet("  a\n\n  b\tc  ", 10)).toBe("a b c");
  });
});
