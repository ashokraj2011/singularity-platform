from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from context_fabric_shared.schemas import LLMRespondRequest, LLMRespondResponse
from context_fabric_shared.costs import estimate_cost
from context_fabric_shared.token_counter import count_message_tokens
from .providers import call_provider, ProviderError
from .repository import init_db, insert_model_call, get_model_call

app = FastAPI(title="Context Fabric - LLM Gateway Service", version="0.1.0")


@app.on_event("startup")
def _startup():
    init_db()


@app.on_event("startup")
async def _register_with_platform() -> None:
    import os as _os
    from .platform_registry import start_self_registration
    await start_self_registration({
        "service_name":  "llm-gateway",
        "display_name":  "Context Fabric LLM Gateway",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8001"),
        "health_path":   "/health",
        "auth_mode":     "none",
        "owner_team":    "context-fabric",
        "metadata":      {"layer": "optimization"},
        "capabilities": [
            {"capability_key": "llm.respond",        "description": "Provider-agnostic LLM completion proxy"},
            {"capability_key": "llm.model-call.audit","description": "Per-call audit + cost record"},
        ],
    })


@app.get("/health")
def health():
    return {"status": "ok", "service": "llm-gateway-service"}


@app.get("/llm/models")
def models():
    return {
        "providers": [
            {"provider": "mock", "models": ["mock-fast", "mock-summarizer"]},
            {"provider": "openrouter", "models": ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "qwen/qwen-2.5-coder-32b-instruct"]},
            {"provider": "openai_compatible", "models": ["gpt-4o-mini", "gpt-4.1-mini"]},
            {"provider": "ollama", "models": ["qwen2.5-coder:7b", "llama3.1:8b"]},
        ]
    }


@app.post("/llm/respond", response_model=LLMRespondResponse)
async def respond(req: LLMRespondRequest):
    try:
        result = await call_provider(
            provider=req.provider,
            model=req.model,
            messages=req.messages,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
        )
        call_id = insert_model_call(
            provider=req.provider,
            model_name=req.model,
            input_tokens=result["input_tokens"],
            output_tokens=result["output_tokens"],
            estimated_cost=result["estimated_cost"],
            latency_ms=result["latency_ms"],
            status="success",
            metadata=req.metadata,
        )
        return LLMRespondResponse(
            response=result["response"],
            provider=req.provider,
            model=req.model,
            input_tokens=result["input_tokens"],
            output_tokens=result["output_tokens"],
            total_tokens=result["input_tokens"] + result["output_tokens"],
            estimated_cost=result["estimated_cost"],
            latency_ms=result["latency_ms"],
            model_call_id=call_id,
            raw_provider_response=result.get("raw_provider_response", {}),
        )
    except ProviderError as e:
        input_tokens = count_message_tokens([m.model_dump() for m in req.messages], model=req.model)
        call_id = insert_model_call(
            provider=req.provider,
            model_name=req.model,
            input_tokens=input_tokens,
            output_tokens=0,
            estimated_cost=estimate_cost(req.provider, req.model, input_tokens, 0),
            latency_ms=0,
            status="failed",
            metadata=req.metadata,
            error=str(e),
        )
        raise HTTPException(status_code=502, detail={"error": str(e), "model_call_id": call_id})


class EstimateRequest(BaseModel):
    provider: str = "mock"
    model: str = "mock-fast"
    messages: list[dict]
    estimated_output_tokens: int = 0


@app.post("/llm/estimate")
def estimate(req: EstimateRequest):
    input_tokens = count_message_tokens(req.messages, model=req.model)
    return {
        "provider": req.provider,
        "model": req.model,
        "input_tokens": input_tokens,
        "estimated_output_tokens": req.estimated_output_tokens,
        "estimated_cost": estimate_cost(req.provider, req.model, input_tokens, req.estimated_output_tokens),
    }


@app.get("/llm/model-calls/{call_id}")
def read_model_call(call_id: str):
    row = get_model_call(call_id)
    if not row:
        raise HTTPException(status_code=404, detail="model call not found")
    return row
