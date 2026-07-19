import { describe, expect, it } from "vitest";
import { saveLayoutSchema, canvasObjectSchema } from "../src/modules/studio/canvas-layout.schema";

describe("canvas-layout saveLayoutSchema", () => {
  it("defaults to an empty personal layout", () => {
    const parsed = saveLayoutSchema.parse({});
    expect(parsed).toEqual({ positions: {}, objects: [] });
  });

  it("accepts sticky position overrides keyed by sticky id", () => {
    const parsed = saveLayoutSchema.parse({
      positions: { "claim:abc": { x: 10, y: 20 }, "probe:xyz": { x: -5, y: 300 } },
      objects: [],
    });
    expect(parsed.positions["claim:abc"]).toEqual({ x: 10, y: 20 });
  });

  it("keeps a viewport when provided and allows null", () => {
    expect(saveLayoutSchema.parse({ viewport: { x: 1, y: 2, z: 0.5 } }).viewport).toEqual({ x: 1, y: 2, z: 0.5 });
    expect(saveLayoutSchema.parse({ viewport: null }).viewport).toBeNull();
  });

  it("rejects non-numeric positions", () => {
    expect(() => saveLayoutSchema.parse({ positions: { a: { x: "1", y: 2 } } })).toThrow();
  });
});

describe("canvas-layout object types", () => {
  it("parses each free-form object kind", () => {
    expect(canvasObjectSchema.parse({ id: "t1", type: "text", x: 0, y: 0, text: "hi" }).type).toBe("text");
    expect(canvasObjectSchema.parse({ id: "s1", type: "shape", x: 0, y: 0, shape: "ellipse" }).type).toBe("shape");
    expect(canvasObjectSchema.parse({ id: "p1", type: "pen", x: 0, y: 0, points: [0, 0, 5, 5] }).type).toBe("pen");
    expect(
      canvasObjectSchema.parse({ id: "i1", type: "image", x: 0, y: 0, storageKey: "synthesis-canvas/p/x.png" }).type,
    ).toBe("image");
  });

  it("text objects default to an empty string and shapes default to rect", () => {
    expect(canvasObjectSchema.parse({ id: "t2", type: "text", x: 0, y: 0 })).toMatchObject({ text: "" });
    expect(canvasObjectSchema.parse({ id: "s2", type: "shape", x: 0, y: 0 })).toMatchObject({ shape: "rect" });
  });

  it("rejects an unknown object type and an image without a storage key", () => {
    expect(() => canvasObjectSchema.parse({ id: "z", type: "gizmo", x: 0, y: 0 })).toThrow();
    expect(() => canvasObjectSchema.parse({ id: "i2", type: "image", x: 0, y: 0 })).toThrow();
  });
});
