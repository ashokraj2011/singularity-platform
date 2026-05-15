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


def count_message_tokens(messages: list[dict], model: str = "mock-fast") -> int:
    total = 0
    for msg in messages:
        total += 4
        total += count_text_tokens(str(msg.get("role", "")), model=model)
        total += count_text_tokens(str(msg.get("content", "")), model=model)
    return total + 2
