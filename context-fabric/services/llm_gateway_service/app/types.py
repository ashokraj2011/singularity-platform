"""M33 — Wire types for the gateway.

Same shape as mcp-server's `LlmRequest` / `LlmResponse` so the shared TS
client can ship without re-mapping fields.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


Role = Literal["system", "user", "assistant", "tool"]


class ChatMessage(BaseModel):
    role: Role
    content: str = ""
    tool_call_id: Optional[str] = None
    tool_name: Optional[str] = None
    # (2026-05-24) Assistant turns that emitted tool calls round-trip
    # through history with the structured tool_use list attached here.
    # Previously this lived inside `content` as JSON, which the provider
    # converters tried to parse — but stage_driver shipped OpenAI-style
    # {id, type, function:{name,arguments}} while the converters
    # expected flat {id, name, args}, so the tool_use list silently
    # dropped on every turn and Anthropic 400'd on the next message
    # because the tool_result had no matching tool_use. Accepting both
    # shapes here lets the converter normalize without a contract break.
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ToolDescriptor(BaseModel):
    name: str
    description: str = ""
    input_schema: Dict[str, Any] = Field(default_factory=dict)


class ChatCompletionRequest(BaseModel):
    # Normal callers must pass `model_alias`. Raw provider/model is accepted
    # only when ALLOW_CALLER_PROVIDER_OVERRIDE=true, which defaults false.
    model_alias: Optional[str] = None
    provider:    Optional[str] = None
    model:       Optional[str] = None

    messages: List[ChatMessage]
    tools:    Optional[List[ToolDescriptor]] = None
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None

    # Stream is not yet implemented on this gateway; surfaced for parity
    # with the OpenAI shape but rejected at request time.
    stream: Optional[bool] = False

    # Optional caller context for audit emission.
    trace_id: Optional[str] = None
    run_id:   Optional[str] = None
    capability_id: Optional[str] = None


class ToolCall(BaseModel):
    id: str
    name: str
    args: Dict[str, Any] = Field(default_factory=dict)


class ChatCompletionResponse(BaseModel):
    content: str
    tool_calls: Optional[List[ToolCall]] = None
    finish_reason: Literal["stop", "tool_call", "length", "error"]
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    provider: str
    model: str
    model_alias: Optional[str] = None
    # M56 — USD cost per call computed from the model catalog's
    # inputPricePerMtok / outputPricePerMtok fields. None when the
    # catalog has no prices for this model (so the workbench can show
    # "—" rather than fake $0.00).
    estimated_cost: Optional[float] = None


class EmbeddingsRequest(BaseModel):
    # Normal callers must pass `model_alias` or rely on the gateway's default
    # alias. Raw provider/model is gated by ALLOW_CALLER_PROVIDER_OVERRIDE.
    model_alias: Optional[str] = None
    provider:    Optional[str] = None
    model:       Optional[str] = None

    input: List[str]

    trace_id: Optional[str] = None
    capability_id: Optional[str] = None


class EmbeddingsResponse(BaseModel):
    embeddings: List[List[float]]
    dim: int
    provider: str
    model: str
    model_alias: Optional[str] = None
    input_tokens: int = 0
    latency_ms: int = 0
