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


class PromptCacheRequest(BaseModel):
    # Server-level prompt caching (ADR 0003). When enabled, the provider
    # adapter pre-fills the stable prefix once per cache TTL instead of
    # re-paying prefill every turn. Mirrors mcp-server's PromptCacheRequest
    # so the shared TS client ships unchanged.
    enabled: bool = False
    # provider_auto | anthropic_cache_control | copilot_gateway. None/omitted
    # is treated as provider_auto.
    strategy: Optional[str] = None
    # Optional caller-supplied cache scope key (session+stage) for
    # observability; providers may ignore it.
    key: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    # Normal callers must pass `model_alias`. Raw provider/model is accepted
    # only when ALLOW_CALLER_PROVIDER_OVERRIDE=true, which defaults false.
    model_alias: Optional[str] = None
    provider:    Optional[str] = None
    model:       Optional[str] = None
    # Optional drift guard for immutable/replay callers. These do not select a
    # model; they assert that alias resolution still matches a frozen bundle.
    expected_provider: Optional[str] = None
    expected_model:    Optional[str] = None

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

    # ADR 0003 — server-level prompt caching. Previously this field did not
    # exist on the gateway request model, so any prompt_cache the caller sent
    # was silently dropped by Pydantic at the hop. Declaring it explicitly is
    # what lets the directive reach the provider adapter.
    prompt_cache: Optional[PromptCacheRequest] = None

    # Stream is not yet implemented on this gateway; surfaced for parity
    # with the OpenAI shape but rejected at request time.
    stream: Optional[bool] = False

    # Optional caller context for audit emission.
    trace_id: Optional[str] = None
    run_id:   Optional[str] = None
    capability_id: Optional[str] = None

    # WHAT this call is for. Until now the gateway knew which model it was
    # asked for and nothing about why — task identity lived inside context-fabric
    # and never crossed the hop, so gateway logs could not answer "how much did
    # planning cost" or "which subsystem is retrying".
    #
    # task_tag is the coarse bucket (agent_turn, world_model_distill, embedding,
    # claim_lowering, …). stage/purpose narrow it when the caller knows more.
    # Optional for now so no caller breaks; GATEWAY_REQUIRE_TASK_TAG flips
    # missing tags from a warning to a 400 once every caller has migrated.
    task_tag: Optional[str] = None
    stage:    Optional[str] = None
    purpose:  Optional[str] = None

    # WHO this call is for. task_tag answered "what kind of work"; these answer
    # "on whose behalf". Without them "what did this user's LLM traffic cost
    # today" is not a hard query, it is an impossible one — no LLM record
    # anywhere in the platform carried an actor.
    #
    # ATTRIBUTION, NOT AUTHORIZATION. The gateway sits behind a single shared
    # bearer, so any caller can claim any actor_id or tenant_id. Sufficient for
    # cost reporting and debugging; categorically insufficient to found tenant
    # isolation on. Do not build RLS on these.
    #
    # Convention once callers migrate: actor_id is never null. A human is a user
    # id; a background call is "system:<service-name>". That keeps null meaning
    # "somebody forgot to propagate it" rather than blurring into "no human".
    actor_id:   Optional[str] = None
    tenant_id:  Optional[str] = None
    # The conversation this turn belongs to, when there is one. Carried so a
    # cost row can be grouped by conversation without joining back through CF.
    session_id: Optional[str] = None

    # Soft routing hint: "cheap" | "standard" | "deep". Distinct from
    # model_alias, which is a hard pin that skips policy entirely. A tier says
    # "pick something in this class for me"; policy resolves it against the
    # catalog. Inert until the policy engine ships.
    model_tier: Optional[str] = None


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
    # ADR 0003 — prompt-cache usage echoed back to the caller so hit rate is
    # measurable. Anthropic reports cache_creation_input_tokens (cache write,
    # ~25% surcharge) and cache_read_input_tokens (cache hit, the cheap path);
    # we surface both plus the effective strategy. None when caching was not
    # requested / not supported by the provider.
    prompt_cache: Optional[Dict[str, Any]] = None


class EmbeddingsRequest(BaseModel):
    # Normal callers must pass `model_alias` or rely on the gateway's default
    # alias. Raw provider/model is gated by ALLOW_CALLER_PROVIDER_OVERRIDE.
    model_alias: Optional[str] = None
    provider:    Optional[str] = None
    model:       Optional[str] = None
    # Drift guard, mirroring ChatCompletionRequest. Absent here until now, and
    # the omission mattered MORE on this endpoint than on chat: a silent
    # embedding-model change corrupts a vector index rather than producing one
    # visibly-off answer. Mixing 1536-dim mock output into a real index is
    # exactly the failure a hard 409 should have been preventing all along.
    expected_provider: Optional[str] = None
    expected_model:    Optional[str] = None

    input: List[str]

    trace_id: Optional[str] = None
    capability_id: Optional[str] = None

    # Same task identity as ChatCompletionRequest — embeddings are the highest-
    # volume gateway traffic, so leaving them untagged would leave the biggest
    # cost line unattributable.
    task_tag: Optional[str] = None
    stage:    Optional[str] = None
    purpose:  Optional[str] = None

    # Same caller identity as ChatCompletionRequest. See the note there: these
    # are attribution, not authorization.
    actor_id:   Optional[str] = None
    tenant_id:  Optional[str] = None
    session_id: Optional[str] = None

    model_tier: Optional[str] = None


class EmbeddingsResponse(BaseModel):
    embeddings: List[List[float]]
    dim: int
    provider: str
    model: str
    model_alias: Optional[str] = None
    input_tokens: int = 0
    latency_ms: int = 0
    # Embeddings are the highest-volume traffic on this gateway and were the
    # only endpoint with no cost path at all — compute_estimated_cost was never
    # called here, so the largest cost line would have landed in llm_calls with
    # cost_usd NULL. None when the catalog prices this model at nothing.
    estimated_cost: Optional[float] = None
