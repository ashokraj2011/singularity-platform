from __future__ import annotations

import time
from typing import Any
import httpx

from context_fabric_shared.schemas import ChatMessage
from context_fabric_shared.token_counter import count_message_tokens, count_text_tokens
from context_fabric_shared.costs import estimate_cost
from .config import settings


class ProviderError(RuntimeError):
    pass


def _messages_to_dicts(messages: list[ChatMessage]) -> list[dict[str, str]]:
    return [{"role": m.role, "content": m.content} for m in messages]


async def call_mock(model: str, messages: list[ChatMessage], temperature: float = 0.2, max_tokens: int | None = None) -> dict[str, Any]:
    start = time.perf_counter()
    last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
    response = (
        "[mock response] Context Fabric received your request. "
        "This mock provider is useful for testing orchestration, context compilation, and token savings without LLM cost.\n\n"
        f"Last user request: {last_user[:800]}"
    )
    input_tokens = count_message_tokens(_messages_to_dicts(messages), model=model)
    output_tokens = count_text_tokens(response, model=model)
    return {
        "response": response,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost": 0.0,
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "raw_provider_response": {"mock": True},
    }


async def call_openrouter(model: str, messages: list[ChatMessage], temperature: float = 0.2, max_tokens: int | None = None) -> dict[str, Any]:
    if not settings.openrouter_api_key:
        raise ProviderError("OPENROUTER_API_KEY is not configured")
    start = time.perf_counter()
    url = settings.openrouter_base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": settings.openrouter_site_url,
        "X-Title": settings.openrouter_app_name,
    }
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages_to_dicts(messages),
        "temperature": temperature,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"OpenRouter error {resp.status_code}: {resp.text[:1000]}")
        data = resp.json()
    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage") or {}
    input_tokens = int(usage.get("prompt_tokens") or count_message_tokens(_messages_to_dicts(messages), model=model))
    output_tokens = int(usage.get("completion_tokens") or count_text_tokens(text, model=model))
    return {
        "response": text,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost": estimate_cost("openrouter", model, input_tokens, output_tokens),
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "raw_provider_response": {"id": data.get("id"), "usage": usage},
    }


async def call_openai_compatible(model: str, messages: list[ChatMessage], temperature: float = 0.2, max_tokens: int | None = None) -> dict[str, Any]:
    if not settings.openai_compatible_api_key:
        raise ProviderError("OPENAI_COMPATIBLE_API_KEY is not configured")
    start = time.perf_counter()
    url = settings.openai_compatible_base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_compatible_api_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages_to_dicts(messages),
        "temperature": temperature,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"OpenAI-compatible error {resp.status_code}: {resp.text[:1000]}")
        data = resp.json()
    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage") or {}
    input_tokens = int(usage.get("prompt_tokens") or count_message_tokens(_messages_to_dicts(messages), model=model))
    output_tokens = int(usage.get("completion_tokens") or count_text_tokens(text, model=model))
    return {
        "response": text,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost": estimate_cost("openai_compatible", model, input_tokens, output_tokens),
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "raw_provider_response": {"id": data.get("id"), "usage": usage},
    }


async def call_ollama(model: str, messages: list[ChatMessage], temperature: float = 0.2, max_tokens: int | None = None) -> dict[str, Any]:
    start = time.perf_counter()
    url = settings.ollama_base_url.rstrip("/") + "/api/chat"
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages_to_dicts(messages),
        "stream": False,
        "options": {"temperature": temperature},
    }
    if max_tokens:
        payload["options"]["num_predict"] = max_tokens
    async with httpx.AsyncClient(timeout=240.0) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            raise ProviderError(f"Ollama error {resp.status_code}: {resp.text[:1000]}")
        data = resp.json()
    text = data.get("message", {}).get("content", "")
    input_tokens = int(data.get("prompt_eval_count") or count_message_tokens(_messages_to_dicts(messages), model=model))
    output_tokens = int(data.get("eval_count") or count_text_tokens(text, model=model))
    return {
        "response": text,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated_cost": 0.0,
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "raw_provider_response": {
            "prompt_eval_count": data.get("prompt_eval_count"),
            "eval_count": data.get("eval_count"),
            "total_duration": data.get("total_duration"),
        },
    }


async def call_provider(provider: str, model: str, messages: list[ChatMessage], temperature: float = 0.2, max_tokens: int | None = None) -> dict[str, Any]:
    provider = provider.lower().strip()
    if provider == "mock":
        return await call_mock(model, messages, temperature, max_tokens)
    if provider == "openrouter":
        return await call_openrouter(model, messages, temperature, max_tokens)
    if provider in {"openai", "openai_compatible", "compatible"}:
        return await call_openai_compatible(model, messages, temperature, max_tokens)
    if provider == "ollama":
        return await call_ollama(model, messages, temperature, max_tokens)
    raise ProviderError(f"Unsupported provider: {provider}")
