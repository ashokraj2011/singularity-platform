"""Direct provider calls for explicitly opted-in Context Fabric nodes.

This module is deliberately separate from ``llm_client``. The normal governed
path uses the LLM gateway (and may use the runtime bridge); this path exists for
nodes whose design explicitly says ``llm_route=context_fabric_direct``. It
supports model completion only. Tool execution still belongs to MCP, so the
governed loop passes only its synthetic ``submit_phase_output`` tool here.

Secrets are never accepted in the workflow payload. A node may name the
environment variable containing its provider key, but Context Fabric validates
that name against an allowlist before reading it.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .llm_client import ChatResponse, ChatToolCall, LLMGatewayError
from ..response_json import UpstreamJsonError, response_json_object

_TRUTHY = {"1", "true", "yes", "on"}
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_DEFAULT_ALLOWED_CREDENTIAL_ENVS = {
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
}


def is_context_fabric_direct_route(run_context: dict[str, Any] | None) -> bool:
    """Return true only for the explicit per-node direct route."""
    context = run_context if isinstance(run_context, dict) else {}
    raw = context.get("llm_route") or context.get("llmRoute") or context.get("llm_execution_route")
    route = str(raw or "").strip().lower().replace("-", "_")
    return route in {
        "context_fabric_direct",
        "direct_context_fabric",
        "context_fabric_llm",
        "cf_direct",
    }


def _direct_config(run_context: dict[str, Any] | None) -> dict[str, Any]:
    context = run_context if isinstance(run_context, dict) else {}
    raw = context.get("direct_llm") or context.get("directLlm") or {}
    return raw if isinstance(raw, dict) else {}


def _env_truthy(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "true" if default else "false").strip().lower() in _TRUTHY


def _allowed_credential_envs() -> set[str]:
    raw = os.environ.get("CONTEXT_FABRIC_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS", "")
    configured = {item.strip().upper() for item in raw.split(",") if item.strip()}
    return configured or set(_DEFAULT_ALLOWED_CREDENTIAL_ENVS)


def _credential(config: dict[str, Any], provider: str) -> str:
    defaults = {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openai_compatible": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
    }
    raw_name = config.get("credential_env") or config.get("credentialEnv") or defaults.get(provider)
    name = str(raw_name or "").strip().upper()
    if not name or not _ENV_NAME.fullmatch(name):
        raise LLMGatewayError(
            "DIRECT_LLM_CREDENTIAL_ENV_INVALID",
            "Context Fabric direct LLM requires a valid uppercase credential env var name.",
        )
    if name not in _allowed_credential_envs():
        raise LLMGatewayError(
            "DIRECT_LLM_CREDENTIAL_ENV_NOT_ALLOWED",
            f"Credential env {name} is not allowed for Context Fabric direct LLM calls.",
        )
    value = os.environ.get(name, "").strip()
    if not value:
        raise LLMGatewayError(
            "DIRECT_LLM_CREDENTIAL_MISSING",
            f"Context Fabric direct LLM credential env {name} is not configured.",
        )
    return value


def _provider_config(
    run_context: dict[str, Any] | None,
    model_alias: str | None,
) -> tuple[str, str, str | None, str | None]:
    config = _direct_config(run_context)
    provider = str(
        config.get("provider")
        or os.environ.get("CONTEXT_FABRIC_DIRECT_LLM_PROVIDER")
        or "mock"
    ).strip().lower().replace("-", "_")
    if provider == "openai-compatible":
        provider = "openai_compatible"
    if provider in {"copilot", "github_copilot"}:
        raise LLMGatewayError(
            "COPILOT_CLI_ONLY",
            "Copilot is available only through the governed copilot_execute MCP path; "
            "use an AGENT_TASK with executor=copilot.",
        )
    allowed = {"mock", "openai", "openai_compatible", "openrouter", "anthropic"}
    if provider not in allowed:
        raise LLMGatewayError("DIRECT_LLM_PROVIDER_UNSUPPORTED", f"Unsupported direct LLM provider: {provider}.")

    model = str(
        config.get("model")
        or os.environ.get("CONTEXT_FABRIC_DIRECT_LLM_MODEL")
        or model_alias
        or ({"anthropic": "claude-3-5-sonnet-latest"}.get(provider, "gpt-4o-mini"))
    ).strip()
    if not model:
        raise LLMGatewayError("DIRECT_LLM_MODEL_MISSING", "Context Fabric direct LLM requires a provider model.")

    base_url = config.get("base_url") or config.get("baseUrl")
    if not base_url:
        base_url = os.environ.get("CONTEXT_FABRIC_DIRECT_LLM_BASE_URL")
    base_url = str(base_url).strip().rstrip("/") if base_url else None
    credential_env = config.get("credential_env") or config.get("credentialEnv")
    return provider, model, base_url, str(credential_env).strip() if credential_env else None


def _ensure_custom_base_url_allowed(base_url: str | None, provider: str) -> str:
    if base_url:
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise LLMGatewayError("DIRECT_LLM_BASE_URL_INVALID", "Direct LLM base URL must be an http(s) URL with a host.")
        known = {
            "openai": "https://api.openai.com/v1",
            "openai_compatible": "https://api.openai.com/v1",
            "openrouter": "https://openrouter.ai/api/v1",
            "anthropic": "https://api.anthropic.com",
        }
        default = known.get(provider)
        custom = default is None or base_url.rstrip("/") != default.rstrip("/")
        if custom and not _env_truthy("CONTEXT_FABRIC_DIRECT_LLM_ALLOW_CUSTOM_BASE_URLS"):
            raise LLMGatewayError(
                "DIRECT_LLM_BASE_URL_NOT_ALLOWED",
                "Custom direct LLM base URLs are disabled; set CONTEXT_FABRIC_DIRECT_LLM_ALLOW_CUSTOM_BASE_URLS=true for a trusted endpoint.",
            )
    if base_url:
        return base_url
    return {
        "openai": "https://api.openai.com/v1",
        "openai_compatible": "https://api.openai.com/v1",
        "openrouter": "https://openrouter.ai/api/v1",
        "anthropic": "https://api.anthropic.com",
    }.get(provider, "")


def _message_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif item is not None:
                parts.append(str(item))
        return "\n".join(parts)
    return "" if value is None else str(value)


def _openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        item = dict(message)
        if item.get("role") == "assistant" and isinstance(item.get("tool_calls"), list):
            calls = []
            for call in item["tool_calls"]:
                if not isinstance(call, dict):
                    continue
                args = call.get("args") or call.get("arguments") or call.get("input") or {}
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                calls.append({
                    "id": str(call.get("id") or "direct-tool-call"),
                    "type": "function",
                    "function": {"name": str(call.get("name") or ""), "arguments": args},
                })
            item["tool_calls"] = calls
        item["content"] = _message_content(item.get("content"))
        result.append(item)
    return result


def _openai_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": str(tool.get("name") or ""),
                "description": str(tool.get("description") or ""),
                "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
            },
        }
        for tool in tools
        if isinstance(tool, dict) and tool.get("name")
    ]


def _anthropic_messages(messages: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
    system: list[str] = []
    result: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "user")
        if role == "system":
            text = _message_content(message.get("content"))
            if text:
                system.append(text)
            continue
        if role == "tool":
            result.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": str(message.get("tool_call_id") or "direct-tool-call"), "content": _message_content(message.get("content"))}],
            })
            continue
        result.append({"role": "assistant" if role == "assistant" else "user", "content": _message_content(message.get("content"))})
    return ("\n\n".join(system) or None), result


def _anthropic_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    return [
        {
            "name": str(tool.get("name") or ""),
            "description": str(tool.get("description") or ""),
            "input_schema": tool.get("input_schema") or {"type": "object", "properties": {}},
        }
        for tool in tools
        if isinstance(tool, dict) and tool.get("name")
    ]


def _tool_calls_from_openai(message: dict[str, Any]) -> list[ChatToolCall]:
    calls: list[ChatToolCall] = []
    for raw in message.get("tool_calls") or []:
        if not isinstance(raw, dict):
            continue
        function = raw.get("function") if isinstance(raw.get("function"), dict) else {}
        args = function.get("arguments") or raw.get("args") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (TypeError, ValueError):
                args = {"_raw": args}
        calls.append(ChatToolCall(id=str(raw.get("id") or "direct-tool-call"), name=str(function.get("name") or raw.get("name") or ""), arguments=args if isinstance(args, dict) else {}))
    return calls


def _tool_calls_from_anthropic(content: Any) -> tuple[str, list[ChatToolCall]]:
    text: list[str] = []
    calls: list[ChatToolCall] = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text.append(str(block.get("text") or ""))
        elif block.get("type") == "tool_use":
            input_value = block.get("input")
            calls.append(ChatToolCall(
                id=str(block.get("id") or "direct-tool-call"),
                name=str(block.get("name") or ""),
                arguments=input_value if isinstance(input_value, dict) else {},
            ))
    return "\n".join(item for item in text if item), calls


async def call_direct_chat(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    model_alias: str | None,
    run_context: dict[str, Any] | None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    timeout_sec: float | None = None,
) -> ChatResponse:
    provider, model, configured_base_url, credential_env = _provider_config(run_context, model_alias)
    if provider == "mock":
        text = "\n".join(_message_content(item.get("content")) for item in messages)
        submit = next((tool for tool in (tools or []) if tool.get("name") == "submit_phase_output"), None)
        calls = []
        if submit:
            calls = [ChatToolCall(id="direct-mock-submit", name="submit_phase_output", arguments={"payload": {"status": "mock-direct", "summary": text[:500]}, "next_phase": "FINALIZE"})]
        reply = "[context-fabric-direct/mock] response"
        return ChatResponse(content=reply, tool_calls=calls, finish_reason="tool_call" if calls else "stop", input_tokens=max(1, len(text) // 4), output_tokens=max(1, len(reply) // 4), latency_ms=1, provider="mock", model=model, model_alias=model_alias or "mock-fast", estimated_cost=0.0)

    base_url = _ensure_custom_base_url_allowed(configured_base_url, provider)
    api_key = _credential({"credential_env": credential_env} if credential_env else {}, provider)
    raw_timeout = timeout_sec if timeout_sec is not None else os.environ.get("CONTEXT_FABRIC_DIRECT_LLM_TIMEOUT_SEC", "300")
    try:
        timeout = max(1.0, min(float(raw_timeout), 7200.0))
    except (TypeError, ValueError):
        timeout = 300.0
    start = time.monotonic()

    if provider == "anthropic":
        system, provider_messages = _anthropic_messages(messages)
        body: dict[str, Any] = {"model": model, "messages": provider_messages, "max_tokens": int(max_output_tokens or 4096)}
        if system:
            body["system"] = system
        if temperature is not None:
            body["temperature"] = temperature
        converted_tools = _anthropic_tools(tools)
        if converted_tools:
            body["tools"] = converted_tools
        url = f"{base_url.rstrip('/')}/v1/messages"
        headers = {"content-type": "application/json", "x-api-key": api_key, "anthropic-version": os.environ.get("ANTHROPIC_VERSION", "2023-06-01")}
    else:
        body = {"model": model, "messages": _openai_messages(messages), "max_tokens": int(max_output_tokens or 4096)}
        if temperature is not None:
            body["temperature"] = temperature
        converted_tools = _openai_tools(tools)
        if converted_tools:
            body["tools"] = converted_tools
            body["tool_choice"] = "auto"
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=body)
    except httpx.TimeoutException as exc:
        raise LLMGatewayError("DIRECT_LLM_TIMEOUT", f"Context Fabric direct LLM timed out after {timeout:g}s.") from exc
    except httpx.HTTPError as exc:
        raise LLMGatewayError("DIRECT_LLM_UNAVAILABLE", f"Context Fabric direct LLM request failed: {exc}") from exc

    if response.status_code == 429:
        raise LLMGatewayError("DIRECT_LLM_RATE_LIMITED", f"Direct provider returned 429: {response.text[:500]}", upstream_status=429)
    if response.status_code >= 400:
        raise LLMGatewayError("DIRECT_LLM_PROVIDER_ERROR", f"Direct provider returned {response.status_code}: {response.text[:1000]}", upstream_status=response.status_code)
    try:
        payload = response_json_object(response, "Context Fabric direct LLM")
    except UpstreamJsonError as exc:
        raise LLMGatewayError("DIRECT_LLM_BAD_RESPONSE", str(exc)) from exc

    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    if provider == "anthropic":
        content, calls = _tool_calls_from_anthropic(payload.get("content"))
        finish = "tool_call" if calls else str(payload.get("stop_reason") or "stop")
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
    else:
        choice = (payload.get("choices") or [None])[0]
        message = choice.get("message") if isinstance(choice, dict) and isinstance(choice.get("message"), dict) else {}
        calls = _tool_calls_from_openai(message)
        content = _message_content(message.get("content"))
        finish = "tool_call" if calls else str((choice or {}).get("finish_reason") or "stop")
        input_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)

    return ChatResponse(
        content=content,
        tool_calls=calls,
        finish_reason=finish,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=int((time.monotonic() - start) * 1000),
        provider=provider,
        model=model,
        model_alias=model_alias,
        estimated_cost=0.0,
    )
