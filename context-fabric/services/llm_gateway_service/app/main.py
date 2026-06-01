"""M33 — LLM Gateway FastAPI app entrypoint.

This is the ONE service in the platform that opens HTTP to provider URLs
declared in the external provider config. Every other service calls
/v1/chat/completions or /v1/embeddings here over HTTP via `LLM_GATEWAY_URL`.
The only allowed fallback is the `mock` provider; the gateway never silently
swaps providers on failure.
"""
from __future__ import annotations

from fastapi import FastAPI

from .router import router as llm_router
from .providers import mock as mock_provider
from .platform_registry import (
    build_registration_payload,
    start_self_registration,
    stop_self_registration,
)


app = FastAPI(title="Singularity LLM Gateway", version="0.1.0")
app.include_router(llm_router)


# ── M65 Slice 3B — Mock admin endpoints for the chaos smoke harness ──────
#
# The mock provider keeps a per-process call counter for "first N calls
# fail" aliases. Tests need to flush it between cases or they cross-
# contaminate. The endpoints below are intentionally unprotected —
# they're for the mock provider only and trigger no side effects on
# real provider state.

@app.post("/v1/mock/reset")
def mock_reset() -> dict:
    """Flush the mock-fail-N-K call counter. Idempotent."""
    mock_provider.reset_call_counts()
    return {"reset": True}


@app.get("/v1/mock/counts")
def mock_counts() -> dict:
    """Diagnostic — show what counter state the mock is in."""
    return {"counts": mock_provider.call_counts_snapshot()}


@app.on_event("startup")
async def _register_with_platform() -> None:
    """Best-effort self-registration with platform-registry, mirroring
    mcp-server. The gateway does not depend on registration succeeding — if
    the registry is unset/down it logs and moves on. Uses the gateway's own
    platform_registry module (present in the image), not a cross-service
    import."""
    try:
        await start_self_registration(build_registration_payload())
    except Exception:  # noqa: BLE001
        # Registration must never block the gateway from serving.
        pass


@app.on_event("shutdown")
async def _deregister_from_platform() -> None:
    """Cancel the heartbeat task on shutdown so the registry's last_seen_at
    goes stale cleanly (mirrors the sibling services)."""
    try:
        await stop_self_registration()
    except Exception:  # noqa: BLE001
        pass
