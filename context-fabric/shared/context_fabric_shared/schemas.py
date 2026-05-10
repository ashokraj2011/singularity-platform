from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field

OptimizationMode = Literal["none", "conservative", "medium", "aggressive", "ultra_aggressive", "code_aware", "audit_safe"]


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ContextPolicy(BaseModel):
    optimization_mode: OptimizationMode | Literal["auto"] = "medium"
    compare_with_raw: bool = True
    max_context_tokens: int = 16000


class OptimizationStats(BaseModel):
    mode: str
    raw_input_tokens: int
    optimized_input_tokens: int
    tokens_saved: int
    percent_saved: float
    estimated_raw_cost: float = 0.0
    estimated_optimized_cost: float = 0.0
    estimated_cost_saved: float = 0.0


class LLMRespondRequest(BaseModel):
    provider: str = "mock"
    model: str = "mock-fast"
    messages: list[ChatMessage]
    temperature: float = 0.2
    max_tokens: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class LLMRespondResponse(BaseModel):
    response: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated_cost: float
    latency_ms: int
    model_call_id: str
    raw_provider_response: dict[str, Any] = Field(default_factory=dict)
