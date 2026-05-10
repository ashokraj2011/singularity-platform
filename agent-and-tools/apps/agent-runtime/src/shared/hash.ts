import { createHash } from "crypto";

export function sha256(input: string | Buffer | Record<string, unknown>): string {
  const data = typeof input === "string" || Buffer.isBuffer(input) ? input : JSON.stringify(input);
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars/token for English text
  return Math.ceil(text.length / 4);
}
