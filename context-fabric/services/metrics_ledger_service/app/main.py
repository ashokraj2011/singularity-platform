from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel
from .repository import init_db, insert_run, list_runs, aggregate, best_mode

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


@app.post("/metrics/token-savings")
def record_token_savings(req: TokenSavingsRequest):
    run_id = insert_run(req.model_dump())
    return {"id": run_id, "status": "recorded"}


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
