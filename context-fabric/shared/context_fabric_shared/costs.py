from __future__ import annotations

# Prices are placeholders for local estimation. Replace with your enterprise pricing table.
# Values are USD per 1M tokens.
DEFAULT_PRICING_PER_1M = {
    "mock": {"input": 0.0, "output": 0.0},
    "ollama": {"input": 0.0, "output": 0.0},
    "openrouter": {"input": 1.0, "output": 3.0},
    "openai_compatible": {"input": 1.0, "output": 3.0},
}

MODEL_OVERRIDES = {
    "openai/gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
}


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int = 0) -> float:
    pricing = MODEL_OVERRIDES.get(model) or DEFAULT_PRICING_PER_1M.get(provider, {"input": 1.0, "output": 3.0})
    return round((input_tokens / 1_000_000.0) * pricing["input"] + (output_tokens / 1_000_000.0) * pricing["output"], 8)


def estimate_input_cost(provider: str, model: str, input_tokens: int) -> float:
    return estimate_cost(provider, model, input_tokens=input_tokens, output_tokens=0)
