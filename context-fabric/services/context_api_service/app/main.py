from __future__ import annotations

from typing import Any
from fastapi import FastAPI, Response
from pydantic import BaseModel, Field

from context_fabric_shared.schemas import ContextPolicy
from context_fabric_shared.http_client import post_json, get_json
from .config import settings
from .internal_mcp import router as internal_mcp_router
from .execute import router as execute_router
from .receipts import router as receipts_router
from .laptop_bridge import (
    router as laptop_bridge_router,
    start_sweep_task as start_laptop_sweep,
    stop_sweep_task as stop_laptop_sweep,
)

app = FastAPI(title="Context Fabric - Context API Service", version="0.1.0")

# M11 follow-up — OpenTelemetry. Must instrument BEFORE include_router so the
# auto-instrumentation patches every route on registration.
from .observability import setup_otel
setup_otel(app, service_name="context-api")

app.include_router(internal_mcp_router)
app.include_router(execute_router)
app.include_router(receipts_router)
# M26 — laptop-resident mcp-server bridge (WS endpoint + connection registry)
app.include_router(laptop_bridge_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "context-api-service"}


@app.get("/healthz/strict")
async def healthz_strict():
    """M28 boot-1 — strict invariants. 200 only when:
       - SQLite paths writable
       - IAM reachable + bootstrap creds set + login mints a JWT
       - audit-gov reachable
    503 + failing-check names otherwise.

    Specifically catches the `Bearer ` empty-token 502 failure mode we hit
    in demo prep when context-api started without IAM_BOOTSTRAP_* env vars.
    """
    from fastapi.responses import JSONResponse
    from .healthz_strict import run_invariant_checks
    result = await run_invariant_checks()
    body = {"ok": result["ok"], "service": "context-api-service", "checks": result["checks"]}
    return JSONResponse(status_code=200 if result["ok"] else 503, content=body)


# M11.a — self-register with platform-registry on startup
@app.on_event("startup")
async def _register_with_platform() -> None:
    import os as _os
    from .platform_registry import start_self_registration
    await start_self_registration({
        "service_name":  "context-api",
        "display_name":  "Context Fabric API",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000"),
        "health_path":   "/health",
        "auth_mode":     "none",
        "owner_team":    "context-fabric",
        "metadata":      {"layer": "optimization+orchestration"},
        "capabilities": [
            {"capability_key": "execute.run",            "description": "Orchestrates compose -> memory -> MCP -> persist"},
            {"capability_key": "execute.resume",         "description": "Resume a paused agent run after approval"},
            {"capability_key": "chat.respond",           "description": "Single-turn LLM call w/ context optimization"},
            {"capability_key": "internal.mcp.adapter",   "description": "Adapter routes for MCP -> tool-service callbacks"},
            {"capability_key": "audit.call-log",         "description": "Per-call audit chain"},
        ],
    })


@app.on_event("startup")
async def _start_laptop_sweep_task() -> None:
    # M26 — periodic sweep of stale laptop-bridge connections.
    start_laptop_sweep()


@app.on_event("shutdown")
async def _stop_platform_register() -> None:
    from .platform_registry import stop_self_registration
    await stop_self_registration()
    stop_laptop_sweep()


class ChatRespondRequest(BaseModel):
    session_id: str
    agent_id: str = "default-agent"
    message: str
    provider: str = "mock"
    model: str = "mock-fast"
    temperature: float = 0.2
    max_output_tokens: int | None = None
    system_prompt: str | None = None
    context_policy: ContextPolicy = Field(default_factory=ContextPolicy)
    summarization: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ChatRespondResponse(BaseModel):
    response: str
    session_id: str
    agent_id: str
    context_package_id: str
    model_call_id: str
    optimization: dict[str, Any]
    model_usage: dict[str, Any]
    metrics_run_id: str | None = None


async def maybe_update_summary(session_id: str, agent_id: str, force: bool = False) -> dict:
    try:
        stats = await get_json(f"{settings.context_memory_url.rstrip('/')}/memory/messages/{session_id}/stats")
        should = force or stats.get("messages_since_summary", 0) >= 8 or stats.get("total_tokens", 0) >= 24000
        if should:
            return await post_json(
                f"{settings.context_memory_url.rstrip('/')}/memory/summaries/update",
                {"session_id": session_id, "agent_id": agent_id, "force": force},
                timeout=180.0,
            )
        return {"updated": False, "reason": "threshold_not_met", "stats": stats}
    except Exception as e:
        # Summarization should not block the main model call in V1.
        return {"updated": False, "reason": "summary_error", "error": str(e)}


@app.post("/chat/respond", response_model=ChatRespondResponse)
async def chat_respond(req: ChatRespondRequest, response: Response):
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "2026-07-01"
    response.headers["Link"] = '</execute>; rel="successor-version"'
    memory_url = settings.context_memory_url.rstrip("/")
    llm_url = settings.llm_gateway_url.rstrip("/")
    metrics_url = settings.metrics_ledger_url.rstrip("/")

    await post_json(f"{memory_url}/memory/messages", {
        "session_id": req.session_id,
        "agent_id": req.agent_id,
        "role": "user",
        "content": req.message,
    })

    force_summary = bool(req.summarization.get("force", False))
    await maybe_update_summary(req.session_id, req.agent_id, force=force_summary)

    compiled = await post_json(f"{memory_url}/context/compile", {
        "session_id": req.session_id,
        "agent_id": req.agent_id,
        "user_message": req.message,
        "optimization_mode": req.context_policy.optimization_mode,
        "compare_with_raw": req.context_policy.compare_with_raw,
        "max_context_tokens": req.context_policy.max_context_tokens,
        "provider": req.provider,
        "model": req.model,
        "system_prompt": req.system_prompt,
    })

    llm_resp = await post_json(f"{llm_url}/llm/respond", {
        "provider": req.provider,
        "model": req.model,
        "messages": compiled["messages"],
        "temperature": req.temperature,
        "max_tokens": req.max_output_tokens,
        "metadata": {
            **req.metadata,
            "session_id": req.session_id,
            "agent_id": req.agent_id,
            "context_package_id": compiled["context_package_id"],
        },
    }, timeout=240.0)

    await post_json(f"{memory_url}/memory/messages", {
        "session_id": req.session_id,
        "agent_id": req.agent_id,
        "role": "assistant",
        "content": llm_resp["response"],
    })

    opt = compiled["optimization"]
    metrics_run_id = None
    try:
        metrics = await post_json(f"{metrics_url}/metrics/token-savings", {
            "session_id": req.session_id,
            "agent_id": req.agent_id,
            "context_package_id": compiled["context_package_id"],
            "model_call_id": llm_resp["model_call_id"],
            "optimization_mode": opt["mode"],
            "raw_input_tokens": opt["raw_input_tokens"],
            "optimized_input_tokens": opt["optimized_input_tokens"],
            "output_tokens": llm_resp.get("output_tokens", 0),
            "tokens_saved": opt["tokens_saved"],
            "percent_saved": opt["percent_saved"],
            "estimated_raw_cost": opt.get("estimated_raw_cost", 0.0),
            "estimated_optimized_cost": opt.get("estimated_optimized_cost", 0.0),
            "estimated_cost_saved": opt.get("estimated_cost_saved", 0.0),
            "provider": req.provider,
            "model_name": req.model,
            "latency_ms": llm_resp.get("latency_ms"),
        })
        metrics_run_id = metrics.get("id")
    except Exception:
        metrics_run_id = None

    return ChatRespondResponse(
        response=llm_resp["response"],
        session_id=req.session_id,
        agent_id=req.agent_id,
        context_package_id=compiled["context_package_id"],
        model_call_id=llm_resp["model_call_id"],
        optimization=opt,
        model_usage={
            "provider": llm_resp["provider"],
            "model": llm_resp["model"],
            "input_tokens": llm_resp["input_tokens"],
            "output_tokens": llm_resp["output_tokens"],
            "total_tokens": llm_resp["total_tokens"],
            "estimated_cost": llm_resp["estimated_cost"],
            "latency_ms": llm_resp["latency_ms"],
        },
        metrics_run_id=metrics_run_id,
    )


class CompareRequest(BaseModel):
    session_id: str
    agent_id: str = "default-agent"
    message: str
    modes: list[str] = Field(default_factory=lambda: ["none", "conservative", "medium", "aggressive"])
    max_context_tokens: int = 16000
    provider: str = "mock"
    model: str = "mock-fast"


@app.post("/context/compare")
async def context_compare(req: CompareRequest):
    return await post_json(f"{settings.context_memory_url.rstrip('/')}/context/compare", req.model_dump())


@app.get("/metrics/dashboard")
async def metrics_dashboard():
    return await get_json(f"{settings.metrics_ledger_url.rstrip('/')}/metrics/dashboard")


@app.get("/sessions/{session_id}/metrics")
async def session_metrics(session_id: str):
    return await get_json(f"{settings.metrics_ledger_url.rstrip('/')}/metrics/savings/session/{session_id}")


@app.get("/sessions/{session_id}/messages")
async def session_messages(session_id: str, limit: int | None = None):
    suffix = f"?limit={limit}" if limit else ""
    return await get_json(f"{settings.context_memory_url.rstrip('/')}/memory/messages/{session_id}{suffix}")
