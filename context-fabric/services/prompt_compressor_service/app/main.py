"""M62 — Prompt Compressor FastAPI app (Slice A).

Skeleton only — /health + /healthz/strict. The /api/v1/compress
endpoint lands in Slice B alongside the validation + result shape.
Keeping this slice tiny makes it cheap to bring the image up and
prove the model bakes correctly before adding business logic.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .compressor import is_loaded, last_load_error, maybe_eager_load
from .config import settings


app = FastAPI(title="Singularity Prompt Compressor Service", version="0.1.0")


@app.on_event("startup")
def startup() -> None:
    # Honour COMPRESSION_LAZY_LOAD. When false, pre-warm the model so
    # the first compress call is fast. Failure is non-fatal — the
    # service still serves /health (which will report the error).
    maybe_eager_load()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.service_name,
        "enabled": settings.compression_enabled,
        "model": settings.compression_model_name,
        "device": settings.compression_device,
        "loaded": is_loaded(),
    }


@app.get("/healthz/strict")
def healthz_strict() -> JSONResponse:
    """Returns 503 only when compression is enabled AND loading the
    model has previously failed. A not-yet-loaded compressor under
    lazy_load=true is healthy — the first request will trigger the
    load and the operator will see the result there.
    """
    err = last_load_error()
    if settings.compression_enabled and err:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "service": settings.service_name, "error": err},
        )
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "service": settings.service_name,
            "enabled": settings.compression_enabled,
            "loaded": is_loaded(),
        },
    )
