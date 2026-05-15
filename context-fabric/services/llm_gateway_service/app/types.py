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


class ToolDescriptor(BaseModel):
    name: str
    description: str = ""
    input_schema: Dict[str, Any] = Field(default_factory=dict)


class ChatCompletionRequest(BaseModel):
    # One of `model_alias` or `(provider + model)` must be set.
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


class EmbeddingsRequest(BaseModel):
    # One of `model_alias` or `(provider + model)`; falls back to default.
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
