from __future__ import annotations

import json
from typing import Any

import httpx


class UpstreamJsonError(RuntimeError):
    def __init__(self, source: str, message: str, status_code: int | None = None, snippet: str | None = None):
        super().__init__(message)
        self.source = source
        self.status_code = status_code
        self.snippet = snippet


def response_snippet(text: str, limit: int = 400) -> str:
    return " ".join((text or "").split())[:limit]


def response_json(response: httpx.Response, source: str) -> Any:
    text = response.text if isinstance(response.text, str) else ""
    try:
        return json.loads(text)
    except ValueError as exc:
        snippet = response_snippet(text)
        raise UpstreamJsonError(
            source,
            f"{source} returned invalid JSON{f': {snippet}' if snippet else ''}",
            response.status_code,
            snippet,
        ) from exc


def response_json_object(response: httpx.Response, source: str) -> dict[str, Any]:
    payload = response_json(response, source)
    if not isinstance(payload, dict):
        raise UpstreamJsonError(
            source,
            f"{source} returned invalid JSON object",
            response.status_code,
            None,
        )
    return payload
