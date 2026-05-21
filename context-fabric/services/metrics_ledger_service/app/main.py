from __future__ import annotations

import json
from fastapi import FastAPI
from pydantic import BaseModel, Field
from .repository import (
    init_db,
    insert_run,
    list_runs,
    aggregate,
    best_mode,
    insert_llm_call,
    list_llm_calls,
    llm_cost_per_converged_capability,
    llm_cost_per_converged_capability_type,
)
from .config import settings

app = FastAPI(title="Context Fabric - Metrics Ledger Service", version="0.1.0")


@app.on_event("startup")
def _startup():
    init_db()


@app.on_event("startup")
async def _register_with_platform() -> None:
    import os as _os
    from .platform_registry import start_self_registration
    await start_self_registration({
        "service_name":  "metrics-ledger",
        "display_name":  "Context Fabric Metrics Ledger",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8003"),
        "health_path":   "/health",
        "auth_mode":     "none",
        "owner_team":    "context-fabric",
        "metadata":      {"layer": "optimization"},
        "capabilities": [
            {"capability_key": "metrics.token-savings", "description": "Per-call token-savings ledger"},
            {"capability_key": "metrics.llm-calls",     "description": "LLM cost and cache ledger"},
            {"capability_key": "metrics.dashboard",     "description": "Aggregated savings rollups"},
        ],
    })


@app.get("/health")
def health():
    return {"status": "ok", "service": "metrics-ledger-service"}


class TokenSavingsRequest(BaseModel):
    session_id: str
    agent_id: str | None = None
    context_package_id: str | None = None
    model_call_id: str | None = None
    optimization_mode: str
    raw_input_tokens: int
    optimized_input_tokens: int
    output_tokens: int = 0
    tokens_saved: int
    percent_saved: float
    estimated_raw_cost: float = 0.0
    estimated_optimized_cost: float = 0.0
    estimated_cost_saved: float = 0.0
    provider: str | None = None
    model_name: str | None = None
    latency_ms: int | None = None
    quality_score: float | None = None


class LlmCallRequest(BaseModel):
    trace_id: str | None = None
    run_id: str | None = None
    capability_id: str | None = None
    capability_type: str | None = None
    workflow_id: str | None = None
    stage_key: str | None = None
    provider: str | None = None
    model_name: str | None = None
    model_alias: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    estimated_cost: float = 0.0
    latency_ms: int | None = None
    converged: bool = False
    metadata: dict = Field(default_factory=dict)


@app.post("/metrics/token-savings")
def record_token_savings(req: TokenSavingsRequest):
    run_id = insert_run(req.model_dump())
    return {"id": run_id, "status": "recorded"}


async def emit_llm_call_audit(payload: dict) -> None:
    if not settings.audit_gov_url or not settings.audit_gov_service_token:
        return
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
              settings.audit_gov_url.rstrip("/") + "/api/v1/events",
              headers={"authorization": f"Bearer {settings.audit_gov_service_token}"},
              json={
                  "trace_id": payload.get("trace_id"),
                  "source_service": "metrics-ledger",
                  "kind": "llm.call.completed",
                  "subject_type": "ModelCall",
                  "subject_id": payload.get("id"),
                  "capability_id": payload.get("capability_id"),
                  "severity": "info",
                  "payload": payload,
              },
            )
    except Exception:
        return


@app.post("/metrics/llm-calls")
async def record_llm_call(req: LlmCallRequest):
    data = req.model_dump()
    data["metadata_json"] = json.dumps(data.pop("metadata", {}) or {})
    call_id = insert_llm_call(data)
    data["id"] = call_id
    await emit_llm_call_audit(data)
    return {"id": call_id, "status": "recorded"}


@app.get("/metrics/llm-calls")
def llm_calls(capability_id: str | None = None, run_id: str | None = None, limit: int = 100):
    if capability_id:
        return {"items": list_llm_calls("WHERE capability_id = ?", (capability_id,), limit)}
    if run_id:
        return {"items": list_llm_calls("WHERE run_id = ?", (run_id,), limit)}
    return {"items": list_llm_calls("", (), limit)}


@app.get("/metrics/llm-calls/cost-per-converged-capability")
def cost_per_converged_capability(capability_id: str | None = None):
    return llm_cost_per_converged_capability(capability_id)


@app.get("/metrics/llm-calls/cost-per-converged-capability-type")
def cost_per_converged_capability_type(capability_type: str | None = None):
    return {"items": llm_cost_per_converged_capability_type(capability_type)}


@app.get("/metrics/dashboard")
def dashboard():
    agg = aggregate()
    agg["best_mode"] = best_mode()
    return agg


@app.get("/metrics/savings/session/{session_id}")
def by_session(session_id: str, limit: int = 100):
    return {"summary": aggregate("WHERE session_id = ?", (session_id,)), "runs": list_runs("WHERE session_id = ?", (session_id,), limit)}


@app.get("/metrics/savings/agent/{agent_id}")
def by_agent(agent_id: str, limit: int = 100):
    return {"summary": aggregate("WHERE agent_id = ?", (agent_id,)), "runs": list_runs("WHERE agent_id = ?", (agent_id,), limit)}


@app.get("/metrics/savings/model/{model_name}")
def by_model(model_name: str, limit: int = 100):
    return {"summary": aggregate("WHERE model_name = ?", (model_name,)), "runs": list_runs("WHERE model_name = ?", (model_name,), limit)}
