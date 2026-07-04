import { describe, expect, it } from "vitest";
import {
  REQUIRED_EMBEDDING_DIM,
  assertDimMatches,
  boundedEmbeddingDim,
  toVectorLiteral,
} from "../src/embeddings/client";

describe("embedding dimension config", () => {
  it.each([undefined, "", " ", "bad", "0", "-1", "NaN", "Infinity"])(
    "falls back to the default for invalid value %s",
    (raw) => {
      expect(boundedEmbeddingDim(raw)).toBe(1536);
    },
  );

  it("accepts positive dimensions", () => {
    expect(boundedEmbeddingDim("768")).toBe(768);
    expect(boundedEmbeddingDim("3072")).toBe(3072);
  });

  it("truncates fractional dimensions", () => {
    expect(boundedEmbeddingDim("1536.9")).toBe(1536);
  });

  it("caps oversized dimensions", () => {
    expect(boundedEmbeddingDim("999999")).toBe(16_000);
  });

  it("keeps assertDimMatches tied to the bounded required dimension", () => {
    expect(REQUIRED_EMBEDDING_DIM).toBe(1536);
    expect(() => assertDimMatches(REQUIRED_EMBEDDING_DIM, "unit-test")).not.toThrow();
    expect(() => assertDimMatches(REQUIRED_EMBEDDING_DIM + 1, "unit-test")).toThrow(
      /dim mismatch/,
    );
  });
});

describe("vector literal formatting", () => {
  it("formats vectors for pgvector", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
});
