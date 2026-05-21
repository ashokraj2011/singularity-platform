/**
 * M44 Slice E — verify breadcrumb dedup collapses consecutive identical
 * lines into "line (x N)" form, both saving breadcrumb capacity and
 * surfacing the loop signal to the model.
 */
import { describe, expect, it } from "vitest";
import { dedupConsecutiveBreadcrumbs } from "../src/mcp/invoke";

describe("M44 dedupConsecutiveBreadcrumbs", () => {
  it("returns empty input unchanged", () => {
    expect(dedupConsecutiveBreadcrumbs([])).toEqual([]);
  });

  it("returns single line unchanged", () => {
    expect(dedupConsecutiveBreadcrumbs(["- read_file(path=Foo.java) -> ok"]))
      .toEqual(["- read_file(path=Foo.java) -> ok"]);
  });

  it("collapses two consecutive identical lines into (x2)", () => {
    expect(dedupConsecutiveBreadcrumbs([
      "- read_file(path=Foo.java) -> ok",
      "- read_file(path=Foo.java) -> ok",
    ])).toEqual([
      "- read_file(path=Foo.java) -> ok (x2)",
    ]);
  });

  it("collapses a long run into one (xN) entry", () => {
    const lines = Array.from({ length: 6 }, () => "- run_command(find ...) -> error: rejected");
    expect(dedupConsecutiveBreadcrumbs(lines)).toEqual([
      "- run_command(find ...) -> error: rejected (x6)",
    ]);
  });

  it("preserves the boundary between runs", () => {
    expect(dedupConsecutiveBreadcrumbs([
      "- read_file(path=A) -> ok",
      "- read_file(path=A) -> ok",
      "- write_file(path=B) -> ok",
      "- read_file(path=A) -> ok",
    ])).toEqual([
      "- read_file(path=A) -> ok (x2)",
      "- write_file(path=B) -> ok",
      "- read_file(path=A) -> ok",
    ]);
  });

  it("is idempotent — running twice doesn't multiply counts", () => {
    const once = dedupConsecutiveBreadcrumbs([
      "- read_file(path=A) -> ok",
      "- read_file(path=A) -> ok",
      "- read_file(path=A) -> ok",
    ]);
    expect(once).toEqual(["- read_file(path=A) -> ok (x3)"]);
    const twice = dedupConsecutiveBreadcrumbs(once);
    expect(twice).toEqual(["- read_file(path=A) -> ok (x3)"]);
  });

  it("merges new identical lines onto a previously-collapsed entry", () => {
    // Simulates the live use case: prior breadcrumbs already had (x3), now
    // two more identical lines come in.
    expect(dedupConsecutiveBreadcrumbs([
      "- read_file(path=A) -> ok (x3)",
      "- read_file(path=A) -> ok",
      "- read_file(path=A) -> ok",
    ])).toEqual([
      "- read_file(path=A) -> ok (x5)",
    ]);
  });

  it("does not collapse near-misses", () => {
    expect(dedupConsecutiveBreadcrumbs([
      "- read_file(path=A) -> ok",
      "- read_file(path=B) -> ok",   // different path
      "- read_file(path=A) -> ok",
    ])).toEqual([
      "- read_file(path=A) -> ok",
      "- read_file(path=B) -> ok",
      "- read_file(path=A) -> ok",
    ]);
  });
});
