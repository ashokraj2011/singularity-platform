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
    # M83.r (2026-05-27) — Anthropic extended thinking blocks emitted
    # by the assistant in a prior turn. When extended thinking is
    # enabled AND tools fired in the same turn, these blocks MUST be
    # threaded back into the assistant message of the next turn (with
    # signatures intact) or Anthropic returns 400 on the tool-result
    # continuation. Each block: {thinking: str, signature: str}.
    # Non-Anthropic providers ignore this field; Anthropic converter
    # emits them as content blocks BEFORE any text or tool_use blocks
    # in the assistant message.
    thinking_blocks: Optional[List[Dict[str, Any]]] = None


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

    # M83.r — Anthropic extended thinking. When set to a positive int,
    # the gateway includes `thinking: {type: "enabled", budget_tokens: N}`
    # in the Anthropic request body. Minimum effective budget is 1024;
    # 4096 is the sweet spot for stage-level reasoning (Claude 4 docs).
    # None / 0 → off (default). Non-Anthropic providers ignore this
    # silently — extended thinking is currently Anthropic-only.
    thinking_budget: Optional[int] = None

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
    # M83.r — Anthropic extended thinking blocks. Each block:
    # {thinking: str, signature: str}. The signature is critical for
    # subsequent tool-use continuation turns — Anthropic validates
    # that thinking blocks emitted in a turn with tool_use are
    # echoed back in the next assistant message with their signatures
    # intact, otherwise the tool_result continuation 400s. Callers
    # that thread history (CF stage_driver) must preserve this list
    # on the assistant ChatMessage they put back into the next turn's
    # messages array (see ChatMessage.thinking_blocks).
    thinking_blocks: Optional[List[Dict[str, Any]]] = None
    # M83.r — output_tokens used by thinking. Anthropic returns this
    # in usage.thinking_tokens (separate from output_tokens). Operators
    # care about it for cost attribution; otherwise the catalog price
    # math would undercount the call.
    thinking_tokens: int = 0


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
