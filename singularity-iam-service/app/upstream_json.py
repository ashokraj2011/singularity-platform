from __future__ import annotations

import json
from typing import Any


def upstream_snippet(text: str, max_chars: int = 500) -> str:
    return " ".join((text or "").split())[:max_chars]


def response_json_object(response: Any, source: str) -> dict[str, Any]:
    text = getattr(response, "text", "") or ""
    status_code = getattr(response, "status_code", "unknown")
    try:
        payload = json.loads(text)
    except ValueError as exc:
        snippet = upstream_snippet(text)
        suffix = f"; body={snippet}" if snippet else ""
        raise ValueError(f"{source} returned invalid JSON ({status_code}): {exc}{suffix}") from exc
    if not isinstance(payload, dict):
        snippet = upstream_snippet(text)
        suffix = f"; body={snippet}" if snippet else ""
        raise ValueError(f"{source} returned invalid JSON object ({status_code}){suffix}")
    return payload


def response_error_message(response: Any, source: str) -> str:
    text = getattr(response, "text", "") or ""
    status_code = getattr(response, "status_code", "unknown")
    try:
        payload = json.loads(text)
    except ValueError:
        body = upstream_snippet(text, 300)
        return f"{source} failed ({status_code}){f': {body}' if body else ''}"
    if isinstance(payload, dict):
        for key in ("error_description", "error", "message", "detail"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return f"{source} failed ({status_code}): {value.strip()[:300]}"
            if value is not None and not isinstance(value, (dict, list)):
                return f"{source} failed ({status_code}): {str(value)[:300]}"
    body = upstream_snippet(text, 300)
    return f"{source} failed ({status_code}){f': {body}' if body else ''}"
