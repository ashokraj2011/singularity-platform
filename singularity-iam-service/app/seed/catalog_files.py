"""Optional file-based extensions to the code-defined RBAC catalog.

The canonical permission/role vocabulary lives in ``default_permissions.py`` /
``default_roles.py`` (code). These loaders let an operator ADD site-specific
permissions and roles from JSON files pointed at by ``IAM_PERMISSION_CATALOG_PATH``
/ ``IAM_ROLE_CATALOG_PATH`` (config.py), so a new key or role ships as config
instead of a code change.

They are purely additive and seeded the same add-only way the code defaults are:
a file entry with a key that already exists in the code defaults is **ignored**
(a file can never override or weaken a shipped permission or system role). Missing
or invalid files degrade to "no extra entries" with a warning — they never raise.

Accepted file shapes (either a bare list or a ``{permissions|roles: [...]}`` wrapper):

    { "permissions": [ { "permission_key": "billing:refund", "category": "billing" } ] }
    { "roles":       [ { "role_key": "billing_clerk", "name": "Billing Clerk",
                         "role_scope": "platform", "permissions": ["billing:refund"] } ] }
"""
from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)


def _read_list(path: str | None, wrapper_key: str) -> list[Any]:
    if not path or not path.strip():
        return []
    try:
        with open(path.strip(), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("IAM catalog file %s not loaded (%s); using code defaults only", path, exc)
        return []
    items = raw.get(wrapper_key) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        log.warning("IAM catalog file %s: expected a list or {%s: [...]}; ignoring", path, wrapper_key)
        return []
    return items


def load_permission_catalog_file(path: str | None) -> list[dict[str, str]]:
    """Extra permissions from ``path``. Each needs a non-empty ``permission_key``;
    ``category`` defaults to ``"custom"``. Bad entries are skipped, not fatal."""
    out: list[dict[str, str]] = []
    for item in _read_list(path, "permissions"):
        if not isinstance(item, dict):
            continue
        key = str(item.get("permission_key") or "").strip()
        if not key:
            log.warning("skipping permission with no permission_key in %s", path)
            continue
        out.append({"permission_key": key, "category": str(item.get("category") or "custom")})
    return out


def load_role_catalog_file(path: str | None) -> list[dict[str, Any]]:
    """Extra roles from ``path``. Each needs a non-empty ``role_key``; ``role_scope``
    defaults to ``"platform"`` and ``system_role`` to ``False``. Bad entries are skipped."""
    out: list[dict[str, Any]] = []
    for item in _read_list(path, "roles"):
        if not isinstance(item, dict):
            continue
        key = str(item.get("role_key") or "").strip()
        if not key:
            log.warning("skipping role with no role_key in %s", path)
            continue
        perms = item.get("permissions") or []
        out.append({
            "role_key": key,
            "name": str(item.get("name") or key),
            "role_scope": str(item.get("role_scope") or "platform"),
            "system_role": bool(item.get("system_role", False)),
            "permissions": [str(p) for p in perms if isinstance(p, str)],
        })
    return out


def merge_permissions(defaults: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Defaults first; an extra entry is appended only if its ``permission_key`` is
    new (defaults win). Returns fresh dicts so callers can mutate them safely."""
    seen = {p["permission_key"] for p in defaults}
    merged = [dict(p) for p in defaults]
    for p in extra:
        if p["permission_key"] not in seen:
            merged.append(dict(p))
            seen.add(p["permission_key"])
    return merged


def merge_roles(defaults: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Defaults first; an extra role is appended only if its ``role_key`` is new
    (a file can never extend or override a shipped system role). Returns fresh dicts."""
    seen = {r["role_key"] for r in defaults}
    merged = [dict(r) for r in defaults]
    for r in extra:
        if r["role_key"] not in seen:
            merged.append(dict(r))
            seen.add(r["role_key"])
    return merged
