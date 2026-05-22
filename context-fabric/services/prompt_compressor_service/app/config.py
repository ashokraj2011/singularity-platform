"""M62 — Prompt compressor service settings.

Single config surface for the FastAPI sidecar. Mirrors the
formal-verifier-service pattern: pydantic-settings, snake_case fields,
case-insensitive env binding, `extra=ignore` so docker-compose can
splash extra env vars into the container without crashing the parser.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    service_name: str = "prompt-compressor-service"

    # Master enable. When false, /api/v1/compress returns 409
    # COMPRESSION_DISABLED and the model is never loaded — useful for
    # bringing the container up in a degraded mode while debugging.
    compression_enabled: bool = True

    # M62 Slice F — compression strategy. Default is the fast
    # deterministic stopword-removal path (no model, microsecond
    # latency, zero ML deps). LLMLingua-2 is opt-in via
    # COMPRESSION_STRATEGY=llmlingua for operators who want
    # model-derived token-importance compression and have spent the
    # 30+ minute first image build to bake the BERT weights.
    #
    # Allowed: "stopwords" | "llmlingua"
    compression_strategy: str = "stopwords"

    # HF model id. Defaults to the one baked into the Dockerfile.
    # Switching at runtime to a non-baked model requires outbound
    # network (TRANSFORMERS_OFFLINE=1 is set in the Dockerfile so
    # the swap will fail loudly rather than silently fetch).
    compression_model_name: str = (
        "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
    )

    # cpu | cuda. The image is built with the CPU torch wheel; flipping
    # to cuda requires a different image. Default cpu so the sidecar
    # runs unchanged on operator laptops.
    compression_device: str = "cpu"

    # When true, the PromptCompressor is constructed on first request.
    # When false, it's constructed at startup so the first request
    # doesn't pay the ~3-5s cold-start cost. Default lazy because
    # most workflows don't actually compress.
    compression_lazy_load: bool = True

    # Safety net — operator can cap how aggressively a caller can
    # request compression. A target_token of 10 on a 5000-token text
    # produces gibberish; below this the service rejects the request.
    compression_min_target_tokens: int = 20

    # Upper bound on the input text size. Defends against a caller
    # passing megabytes — llmlingua-2 BERT base scales O(n) but
    # tokenization at 1MB+ is several seconds and dominates the
    # request budget.
    compression_max_input_chars: int = 200_000


settings = Settings()
