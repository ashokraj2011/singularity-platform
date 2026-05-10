import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "./types";

const DEFAULT_MODEL = "text-embedding-3-small"; // 1536-dim, cheapest hosted option

interface OpenAiEmbedResp {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly defaultModel: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const start = Date.now();
    const model = req.model ?? this.defaultModel;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, input: req.text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`OpenAI embeddings ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as OpenAiEmbedResp;
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("OpenAI returned no embedding");
    }
    return {
      vector,
      provider: this.name,
      model: body.model || model,
      dim: vector.length,
      metadata: {
        latencyMs: Date.now() - start,
        promptTokens: body.usage?.prompt_tokens,
      },
    };
  }
}
