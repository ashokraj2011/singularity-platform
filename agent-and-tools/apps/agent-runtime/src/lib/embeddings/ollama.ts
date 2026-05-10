import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "./types";

const DEFAULT_MODEL = "nomic-embed-text"; // 768-dim, runs in local ollama daemon

interface OllamaEmbedResp {
  embedding: number[];
  model?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly defaultModel: string;
  private baseUrl: string;

  constructor(opts: { baseUrl?: string; defaultModel?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "http://host.docker.internal:11434";
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const start = Date.now();
    const model = req.model ?? this.defaultModel;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: req.text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`Ollama embeddings ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as OllamaEmbedResp;
    const vector = body.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Ollama returned no embedding (is the model pulled? `ollama pull nomic-embed-text`)");
    }
    return {
      vector,
      provider: this.name,
      model: body.model || model,
      dim: vector.length,
      metadata: { latencyMs: Date.now() - start },
    };
  }
}
