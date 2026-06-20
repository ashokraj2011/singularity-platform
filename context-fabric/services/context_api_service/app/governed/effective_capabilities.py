from __future__ import annotations

from typing import Any

_TRUTHY = {"1", "true", "yes", "on"}


def effective_capabilities_from_context(run_context: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(run_context, dict):
        return []
    raw = run_context.get("effective_capabilities") or run_context.get("effectiveCapabilities")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def effective_capabilities_required(run_context: dict[str, Any] | None) -> bool:
    if not isinstance(run_context, dict):
        return False
    raw = run_context.get("effective_capabilities_required")
    if raw is None:
        raw = run_context.get("effectiveCapabilitiesRequired")
    return raw is True or (isinstance(raw, str) and raw.strip().lower() in _TRUTHY)


def effective_capabilities_required_but_empty(run_context: dict[str, Any] | None) -> bool:
    return (
        effective_capabilities_required(run_context)
        and not effective_capabilities_from_context(run_context)
    )
