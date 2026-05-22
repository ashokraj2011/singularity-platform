"""Standalone context-memory FastAPI app.

M67 Slice 1C — Folded into context-api. The route logic moved to
`routes.py` (FastAPI APIRouter) so both this thin standalone app AND
context-api can mount it without duplicating code.

This file is kept for one operator cycle to give callers with explicit
`CONTEXT_MEMORY_URL=http://context-memory:8002` a graceful migration
path. New deployments should target context-api directly; the standalone
service is no longer in the `full` compose profile.
"""
from __future__ import annotations

from fastapi import FastAPI

from .routes import router, ensure_memory_schema, warm_system_prompts

app = FastAPI(title="Context Fabric - Context Memory Service", version="0.1.0")
app.include_router(router)


@app.on_event("startup")
def _startup():
    ensure_memory_schema()


@app.on_event("startup")
async def _warm_system_prompts() -> None:
    await warm_system_prompts()


@app.on_event("startup")
async def _register_with_platform() -> None:
    import os as _os
    from .platform_registry import start_self_registration
    await start_self_registration({
        "service_name":  "context-memory",
        "display_name":  "Context Fabric Memory",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8002"),
        "health_path":   "/health",
        "auth_mode":     "none",
        "owner_team":    "context-fabric",
        "metadata":      {"layer": "optimization"},
        "capabilities": [
            {"capability_key": "memory.messages",   "description": "Conversation message history"},
            {"capability_key": "memory.summaries",  "description": "Rolling conversation summaries"},
            {"capability_key": "memory.search",     "description": "Distilled-knowledge semantic search"},
            {"capability_key": "context.compile",   "description": "Compile optimized context package for LLM call"},
        ],
    })


@app.get("/health")
def health():
    return {"status": "ok", "service": "context-memory-service"}
