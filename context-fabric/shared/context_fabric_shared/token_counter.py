from __future__ import annotations

import math
from functools import lru_cache


@lru_cache(maxsize=16)
def _encoding_for_model(model: str):
    try:
        import tiktoken  # type: ignore
        try:
            return tiktoken.encoding_for_model(model)
        except Exception:
            return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def count_text_tokens(text: str, model: str = "mock-fast") -> int:
    if not text:
        return 0
    enc = _encoding_for_model(model)
    if enc is not None:
        try:
            return len(enc.encode(text))
        except Exception:
            pass
    return max(1, math.ceil(len(text) / 4))


def trim_text_to_tokens(text: str, max_tokens: int, model: str = "mock-fast") -> str:
    """Trim `text` so it fits within `max_tokens`, cutting on TOKEN boundaries
    (encode → slice → decode) rather than raw characters. Falls back to the
    same ~4-chars-per-token heuristic used by count_text_tokens when tiktoken
    is unavailable. Returns the text unchanged when it already fits.

    Used by the context compiler to budget-fit individual context sections
    without the char-slicing imprecision of the old approach.
    """
    if max_tokens <= 0:
        return ""
    if not text:
        return text
    enc = _encoding_for_model(model)
    if enc is not None:
        try:
            tokens = enc.encode(text)
            if len(tokens) <= max_tokens:
                return text
            return enc.decode(tokens[:max_tokens])
        except Exception:
            pass
    # Heuristic fallback: ~4 chars per token (mirrors count_text_tokens).
    if count_text_tokens(text, model=model) <= max_tokens:
        return text
    return text[: max(0, max_tokens * 4)]


def count_message_tokens(messages: list[dict], model: str = "mock-fast") -> int:
    total = 0
    for msg in messages:
        total += 4
        total += count_text_tokens(str(msg.get("role", "")), model=model)
        total += count_text_tokens(str(msg.get("content", "")), model=model)
    return total + 2
