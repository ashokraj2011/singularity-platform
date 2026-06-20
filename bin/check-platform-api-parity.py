#!/usr/bin/env python3
"""Smoke-check unified Platform Web API proxy parity.

This complements check-platform-web-routes.py. The route checker proves pages
and a few UI-era API aliases load; this checker is intentionally backend/API
oriented so legacy and canonical API surfaces cannot drift silently during the
single-web-app migration.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class ApiExpectation:
    name: str
    path: str
    statuses: set[int]
    shape: str = "any"
    forbidden_keys: tuple[str, ...] = ()


BAD_BODY_PATTERNS = [
    re.compile(r"<!DOCTYPE html", re.I),
    re.compile(r"<html\b", re.I),
    re.compile(r"Internal Server Error", re.I),
    re.compile(r"Unexpected token", re.I),
    re.compile(r"Cannot (GET|POST|PUT|PATCH|DELETE) ", re.I),
]

USER_API_STATUSES = {200, 401, 403}


CANONICAL_API_CHECKS = [
    ApiExpectation("iam health", "/api/iam/health", {200}, "object"),
    ApiExpectation("agent-service agents", "/api/agents/agents", USER_API_STATUSES, "object"),
    ApiExpectation("tool-service registry", "/api/tools", USER_API_STATUSES, "object"),
    ApiExpectation("agent-runtime capabilities", "/api/runtime/capabilities", USER_API_STATUSES, "json"),
    ApiExpectation("agent-runtime templates", "/api/runtime/agents/templates?scope=common&size=1", USER_API_STATUSES, "object"),
    ApiExpectation("prompt-composer profiles", "/api/composer/prompt-profiles?size=1", USER_API_STATUSES, "object"),
    ApiExpectation("workgraph templates", "/api/workgraph/workflow-templates?size=1", USER_API_STATUSES, "object"),
    ApiExpectation("context fabric health", "/api/cf/health", {200}, "object"),
    ApiExpectation("code foundry runs", "/api/codegen/runs", USER_API_STATUSES, "object"),
    ApiExpectation("llm settings readiness", "/api/llm-settings", USER_API_STATUSES, "object", ("authToken", "authorization", "Authorization", "apiKey", "api_key", "secret")),
    ApiExpectation("runtime infrastructure readiness", "/api/runtime-infrastructure", USER_API_STATUSES, "object", ("authToken",)),
]


LEGACY_API_ALIAS_CHECKS = [
    # These are user-scoped API surfaces. An unauthenticated parity probe may
    # receive structured JSON 401/403; that still proves the proxy is wired and
    # avoids the original failure mode of raw HTML/"Internal Server Error".
    ApiExpectation("legacy workflow templates alias", "/workflow/api/workflow-templates?size=1", USER_API_STATUSES, "object"),
    ApiExpectation("workflows templates alias", "/workflows/api/workflow-templates?size=1", USER_API_STATUSES, "object"),
    ApiExpectation("legacy workflow runs alias", "/workflow/api/runs?mine=true", USER_API_STATUSES, "json"),
    ApiExpectation("legacy workflow connectors alias", "/workflow/api/connectors", USER_API_STATUSES, "json"),
    ApiExpectation("workbench blueprint alias", "/workbench/api/blueprint/sessions", USER_API_STATUSES, "json"),
    ApiExpectation("foundry codegen alias", "/foundry/api/codegen/runs", USER_API_STATUSES, "object"),
]


OPTIONAL_API_CHECKS = [
    # audit-governance is an optional side stack locally. The platform proxy
    # still must normalize unavailable/not-found responses as JSON.
    ApiExpectation("audit-gov canonical proxy", "/api/audit-gov/health", {200, 401, 403, 404, 502}, "object"),
    ApiExpectation("audit-gov workbench alias", "/workbench/audit-gov/health", {200, 401, 403, 404, 502}, "object"),
]


def read_json(base_url: str, item: ApiExpectation, timeout: float) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}{item.path}"
    try:
        with urlopen(Request(url, headers={"user-agent": "singularity-platform-api-parity"}), timeout=timeout) as response:
            status = response.status
            content_type = response.headers.get("content-type", "")
            body = response.read(1_000_000).decode("utf-8", "replace")
    except HTTPError as exc:
        status = exc.code
        content_type = exc.headers.get("content-type", "")
        body = exc.read(1_000_000).decode("utf-8", "replace")
    except (OSError, URLError, TimeoutError) as exc:
        return False, f"ERR {item.name}: {item.path} {exc}"

    if status not in item.statuses:
        return False, f"{status} {item.name}: {item.path} expected {sorted(item.statuses)}"
    if "json" not in content_type.lower():
        return False, f"{status} {item.name}: {item.path} non-JSON content-type {content_type or '-'}"

    for pattern in BAD_BODY_PATTERNS:
        match = pattern.search(body)
        if match:
            snippet = body[max(0, match.start() - 80): match.end() + 120]
            snippet = re.sub(r"\s+", " ", snippet).strip()
            return False, f"{status} {item.name}: {item.path} bad body {snippet[:220]}"

    try:
        parsed = json.loads(body or "{}")
    except json.JSONDecodeError as exc:
        return False, f"{status} {item.name}: {item.path} invalid JSON: {exc}"

    if item.shape == "object" and not isinstance(parsed, dict):
        return False, f"{status} {item.name}: {item.path} expected object JSON"
    if item.shape == "array" and not isinstance(parsed, list):
        return False, f"{status} {item.name}: {item.path} expected array JSON"

    leaked_path = first_forbidden_key_path(parsed, set(item.forbidden_keys))
    if leaked_path:
        return False, f"{status} {item.name}: {item.path} leaked forbidden response key {leaked_path}"

    return True, f"{status} {item.name}: {item.path}"


def first_forbidden_key_path(value: object, forbidden: set[str], path: str = "$") -> str | None:
    if not forbidden:
        return None
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if str(key) in forbidden:
                return child_path
            found = first_forbidden_key_path(child, forbidden, child_path)
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = first_forbidden_key_path(child, forbidden, f"{path}[{index}]")
            if found:
                return found
    return None


def run_checks(base_url: str, timeout: float, include_optional: bool) -> int:
    failures = 0
    checks = [*CANONICAL_API_CHECKS, *LEGACY_API_ALIAS_CHECKS]
    if include_optional:
        checks.extend(OPTIONAL_API_CHECKS)

    for item in checks:
        ok, message = read_json(base_url, item, timeout)
        print(("OK  " if ok else "FAIL ") + message)
        failures += 0 if ok else 1

    if failures:
        print(f"\n{failures} platform API parity check(s) failed.", file=sys.stderr)
        return 1
    print("\nPlatform API parity checks passed.")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--skip-optional", action="store_true", help="skip optional side-stack API proxies")
    args = parser.parse_args(argv)
    return run_checks(args.base_url, args.timeout, include_optional=not args.skip_optional)


if __name__ == "__main__":
    raise SystemExit(main())
