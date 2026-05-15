"""M33 — LLM Gateway FastAPI app entrypoint.

This is the ONE service in the platform that opens HTTP to provider URLs
declared in the external provider config. Every other service calls
/v1/chat/completions or /v1/embeddings here over HTTP via `LLM_GATEWAY_URL`.
The only allowed fallback is the `mock` provider; the gateway never silently
swaps providers on failure.
"""
from __future__ import annotations

import os

from fastapi import FastAPI

from .router import router as llm_router


app = FastAPI(title="Singularity LLM Gateway", version="0.1.0")
app.include_router(llm_router)


@app.on_event("startup")
async def _register_with_platform() -> None:
    """Best-effort registration with platform-registry. The gateway does not
    depend on registration succeeding — if the registry is down it logs and
    moves on. (Mirrors the pattern used by context_memory_service.)"""
    base_url = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8001")
    try:
        # Defer import so the registry helper is optional in slimmer envs.
        from services.context_memory_service.app.platform_registry import start_self_registration  # type: ignore
    except Exception:
        return
    try:
        await start_self_registration({
            "service_name":  "llm-gateway",
            "display_name":  "Singularity LLM Gateway",
            "version":       "0.1.0",
            "base_url":      base_url,
            "health_path":   "/health",
            "auth_mode":     "bearer" if os.environ.get("LLM_GATEWAY_BEARER") else "none",
            "owner_team":    "context-fabric",
            "metadata":      {"layer": "optimization", "role": "llm-gateway"},
            "capabilities": [
                {"capability_key": "llm.chat",       "description": "Chat completions across all providers"},
                {"capability_key": "llm.embeddings", "description": "Embeddings across all providers"},
            ],
        })
    except Exception:
        pass
