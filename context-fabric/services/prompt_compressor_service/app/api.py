"""M62 Slice B — POST /api/v1/compress endpoint.

Single-call compression. Wraps llmlingua's PromptCompressor with:
  - input validation (text size cap, target_token floor, exactly-one
    of target_token/rate)
  - structured 4xx errors instead of raw tracebacks
  - per-call timing + structured log line for ops greppability
  - deterministic receipt_id so callers can correlate (e.g. for the
    Slice D layer-receipt audit trail)

Kept separate from main.py so the FastAPI app composition stays small
and the validation logic is unit-testable without a TestClient.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from .compressor import is_loaded, load_compressor
from .config import settings
from .strategies import stopwords as stopwords_strategy

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["compress"])


class CompressRequest(BaseModel):
    text: str = Field(..., description="The content to compress.")
    target_token: Optional[int] = Field(
        None,
        description="Absolute token target. Mutually exclusive with `rate`.",
    )
    rate: Optional[float] = Field(
        None,
        ge=0.05,
        le=0.95,
        description="Fractional target, e.g. 0.5 = compress to 50% of original. Mutually exclusive with `target_token`.",
    )
    instruction: str = Field(
        "",
        description="LLMLingua's pre-context, kept verbatim by the model.",
    )
    question: str = Field(
        "",
        description="LLMLingua's post-context, kept verbatim by the model.",
    )
    force_tokens: list[str] = Field(
        default_factory=list,
        description="Substrings the model must NOT drop (e.g. symbol names, file paths).",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Audit-only — echoed back in the receipt log line. Not consumed by the compressor.",
    )

    @model_validator(mode="after")
    def _exactly_one_target(self) -> "CompressRequest":
        has_token = self.target_token is not None
        has_rate = self.rate is not None
        if has_token == has_rate:  # both true OR both false
            raise ValueError("specify exactly one of `target_token` or `rate`")
        return self


class CompressResponse(BaseModel):
    compressed_text: str
    original_tokens: int
    compressed_tokens: int
    ratio: float
    model: str
    duration_ms: int
    receipt_id: str
    warning: Optional[str] = None


@router.post("/compress", response_model=CompressResponse)
def compress(req: CompressRequest) -> CompressResponse:
    if not settings.compression_enabled:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "COMPRESSION_DISABLED",
                "message": "Compression is disabled at the service level.",
            },
        )

    # Input size guardrail. llmlingua-2 BERT base scales O(n) but
    # tokenization at multi-MB is several seconds and dominates the
    # caller's request budget. Reject early with a clear reason.
    if len(req.text) > settings.compression_max_input_chars:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "TEXT_TOO_LARGE",
                "message": f"text exceeds {settings.compression_max_input_chars} chars (got {len(req.text)})",
            },
        )

    # target_token floor — below this the output is gibberish and the
    # caller almost certainly has a bug.
    if req.target_token is not None and req.target_token < settings.compression_min_target_tokens:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "TARGET_TOKEN_TOO_LOW",
                "message": f"target_token must be >= {settings.compression_min_target_tokens}",
            },
        )

    # Below-threshold short-circuit. Compressing a 30-char prompt is
    # pure waste — return the original with a warning so the caller
    # knows nothing happened.
    if len(req.text) < 100:
        return CompressResponse(
            compressed_text=req.text,
            original_tokens=_rough_token_count(req.text),
            compressed_tokens=_rough_token_count(req.text),
            ratio=1.0,
            model=_model_label(),
            duration_ms=0,
            receipt_id=_receipt_id(),
            warning="text below 100 chars — compression skipped",
        )

    # M62 Slice F — Strategy dispatch. Default is stopwords (fast,
    # deterministic, no model). LLMLingua-2 is opt-in via
    # COMPRESSION_STRATEGY=llmlingua.
    if settings.compression_strategy == "stopwords":
        return _compress_via_stopwords(req)
    if settings.compression_strategy != "llmlingua":
        raise HTTPException(
            status_code=500,
            detail={
                "code": "INVALID_STRATEGY",
                "message": f"unknown COMPRESSION_STRATEGY={settings.compression_strategy}",
            },
        )

    # ----- LLMLingua-2 path -----------------------------------------------
    # Load the model (lazy). If loading fails, surface as 503 so the
    # caller's circuit breaker can react sensibly.
    try:
        compressor = load_compressor()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "COMPRESSOR_UNAVAILABLE", "message": str(exc)},
        ) from exc

    started = time.perf_counter()
    try:
        # llmlingua-2 quirk: target_token is documented as the rough
        # output length; the actual length floats ±10%. force_tokens
        # is preserved exactly. Use empty strings for instruction /
        # question when the caller didn't specify — llmlingua treats
        # those positionally.
        kwargs: dict[str, Any] = {
            "context": req.text,
            "instruction": req.instruction,
            "question": req.question,
        }
        if req.target_token is not None:
            kwargs["target_token"] = req.target_token
        else:
            kwargs["rate"] = req.rate
        if req.force_tokens:
            kwargs["force_tokens"] = req.force_tokens

        result = compressor.compress_prompt(**kwargs)
    except Exception as exc:  # pylint: disable=broad-except
        # llmlingua raises a variety of exceptions (KeyError on weird
        # tokenizer state, ValueError on bad target_token math, etc.).
        # Collapse them to a single 422 — the caller can't distinguish
        # them meaningfully and shouldn't retry blindly.
        log.exception("[compress] failure")
        raise HTTPException(
            status_code=422,
            detail={"code": "COMPRESSION_FAILED", "message": f"{type(exc).__name__}: {exc}"},
        ) from exc

    took_ms = int((time.perf_counter() - started) * 1000)
    compressed_text = str(result.get("compressed_prompt", req.text))
    original_tokens = int(result.get("origin_tokens", _rough_token_count(req.text)))
    compressed_tokens = int(result.get("compressed_tokens", _rough_token_count(compressed_text)))
    ratio = (compressed_tokens / original_tokens) if original_tokens > 0 else 1.0
    receipt = _receipt_id()

    log.info(
        "[compress] receipt=%s tokens=%d→%d ratio=%.3f ms=%d model=%s meta=%s",
        receipt,
        original_tokens,
        compressed_tokens,
        ratio,
        took_ms,
        settings.compression_model_name,
        req.metadata or {},
    )

    warning: Optional[str] = None
    if req.target_token is not None and abs(compressed_tokens - req.target_token) / max(req.target_token, 1) > 0.25:
        # Soft-warn when the model misses target by >25%. Not an error —
        # llmlingua sometimes can't hit aggressive targets cleanly —
        # but the caller may want to log/alert.
        warning = f"compressed_tokens={compressed_tokens} missed target_token={req.target_token} by >25%"

    return CompressResponse(
        compressed_text=compressed_text,
        original_tokens=original_tokens,
        compressed_tokens=compressed_tokens,
        ratio=round(ratio, 4),
        model=settings.compression_model_name,
        duration_ms=took_ms,
        receipt_id=receipt,
        warning=warning,
    )


@router.get("/status")
def status() -> dict[str, Any]:
    """Operator-facing status. Mirrors formal-verifier-service's
    /api/v1/verification/status: more detail than /health, including
    whether the model is currently resident and (when not) the most
    recent load failure reason.
    """
    return {
        "enabled": settings.compression_enabled,
        # M62 Slice F — strategy switch. "stopwords" is the default
        # zero-ML path; "llmlingua" routes through the BERT model below.
        "strategy": settings.compression_strategy,
        "model": _model_label(),
        "device": settings.compression_device,
        # `loaded` only meaningful for the llmlingua strategy. Always
        # false (and ignored) when strategy=stopwords.
        "loaded": is_loaded() if settings.compression_strategy == "llmlingua" else None,
        "lazy_load": settings.compression_lazy_load,
        "min_target_tokens": settings.compression_min_target_tokens,
        "max_input_chars": settings.compression_max_input_chars,
    }


# ---------- Strategy: stopwords --------------------------------------------

def _compress_via_stopwords(req: CompressRequest) -> CompressResponse:
    """M62 Slice F — Default compression strategy.

    Drops common English filler words. Operates in microseconds with
    zero ML dependencies. Quality is lower than LLMLingua-2 but the
    output stays human-readable (debugging win) and there's no model
    cold-start.

    Contract notes vs LLMLingua-2:
      - target_token / rate are ADVISORY only. The stopword pass is
        deterministic; we report the actual count and let the caller
        decide whether to switch strategies.
      - force_tokens is honoured (whole-word, case-sensitive match).
      - instruction / question are pre-pended / appended verbatim to
        match LLMLingua's call shape.
    """
    started = time.perf_counter()
    body_compressed = stopwords_strategy.compress_text(
        req.text,
        force_tokens=req.force_tokens or None,
    )
    parts: list[str] = []
    if req.instruction:
        parts.append(req.instruction)
    if body_compressed:
        parts.append(body_compressed)
    if req.question:
        parts.append(req.question)
    compressed_text = "\n\n".join(parts) if parts else body_compressed
    took_ms = int((time.perf_counter() - started) * 1000)

    original_tokens = _rough_token_count(req.text)
    compressed_tokens = _rough_token_count(compressed_text)
    ratio = (compressed_tokens / original_tokens) if original_tokens > 0 else 1.0
    receipt = _receipt_id()

    warning: Optional[str] = None
    # If the caller asked for an absolute target the stopword pass
    # missed by a wide margin, flag it — they may want to switch to
    # COMPRESSION_STRATEGY=llmlingua for that workload.
    if req.target_token is not None and compressed_tokens > req.target_token * 1.5:
        warning = (
            f"stopwords strategy yielded {compressed_tokens} tokens, "
            f"target was {req.target_token}. Consider COMPRESSION_STRATEGY=llmlingua "
            f"for tighter targets."
        )

    log.info(
        "[compress.stopwords] receipt=%s tokens=%d→%d ratio=%.3f ms=%d meta=%s",
        receipt,
        original_tokens,
        compressed_tokens,
        ratio,
        took_ms,
        req.metadata or {},
    )

    return CompressResponse(
        compressed_text=compressed_text,
        original_tokens=original_tokens,
        compressed_tokens=compressed_tokens,
        ratio=round(ratio, 4),
        model="stopwords-v1",  # NOT settings.compression_model_name (that's the LLMLingua one)
        duration_ms=took_ms,
        receipt_id=receipt,
        warning=warning,
    )


# ---------- Helpers ---------------------------------------------------------

def _model_label() -> str:
    """The 'model' field in the response. For stopwords we report the
    strategy version; for LLMLingua we report the loaded HF model id.
    """
    if settings.compression_strategy == "stopwords":
        return "stopwords-v1"
    return settings.compression_model_name


def _receipt_id() -> str:
    return f"cmprx-{uuid.uuid4().hex[:12]}"


def _rough_token_count(text: str) -> int:
    """Pre-load token estimate used by the early-skip path AND as a
    fallback when llmlingua doesn't return token counts in its result
    dict (older versions don't). Same heuristic prompt-composer uses
    (~4 chars/token for English prose) so the two services agree on
    relative sizing.
    """
    return max(1, len(text) // 4)
