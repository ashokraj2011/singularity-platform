from __future__ import annotations

import json
from typing import Any

import httpx


def _json_object(resp: httpx.Response, url: str) -> dict[str, Any]:
    text = resp.text or ""
    if not text.strip():
        raise ValueError(f"{url} returned an empty JSON response ({resp.status_code})")
    try:
        parsed = json.loads(text)
    except Exception as exc:
        raise ValueError(f"{url} returned invalid JSON ({resp.status_code}): {exc}; body={text[:300]}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{url} returned non-object JSON ({resp.status_code})")
    return parsed


async def post_json(url: str, payload: dict, timeout: float = 120.0) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return _json_object(resp, url)


async def get_json(url: str, timeout: float = 60.0) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return _json_object(resp, url)
