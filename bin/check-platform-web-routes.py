#!/usr/bin/env python3
"""Smoke-check Platform Web canonical routes and legacy redirects."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


@dataclass(frozen=True)
class RouteExpectation:
    path: str
    status: int
    location: str | None = None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):  # type: ignore[override]
        return None


CANONICAL_ROUTES = [
    "/",
    "/control-plane",
    "/operations",
    "/operations/access-keys",
    "/operations/architecture",
    "/operations/readiness",
    "/operations/setup",
    "/operations/trust",
    "/agents",
    "/agents/studio",
    "/capabilities",
    "/tools",
    "/executions",
    "/prompt-profiles",
    "/prompt-workbench",
    "/prompt-layers",
    "/tool-grants",
    "/runtime-executions",
    "/memory",
    "/workflows",
    "/workflows/templates",
    "/workflows/planner",
    "/workflows/inbox",
    "/workflows/run",
    "/workflows/work/task/abc",
    "/workflows/connectors",
    "/workflows/metadata",
    "/workflows/node-types",
    "/workflows/artifacts",
    "/workflows/artifacts/explorer",
    "/workflows/history",
    "/workflows/runtime",
    "/workflows/design/30000000-0000-0000-0000-000000000012",
    "/runs",
    "/work-items",
    "/workbench",
    "/workbench/cockpit",
    "/workbench/loop-theater",
    "/workbench/governance",
    "/workbench/artifacts",
    "/workbench/audit",
    "/workbench/code-review",
    "/workbench/export",
    "/workbench/milestones",
    "/workbench/stage-chat",
    "/foundry",
    "/foundry/artifacts",
    "/foundry/change-plans",
    "/foundry/gaps",
    "/foundry/history",
    "/foundry/llm-tasks",
    "/foundry/receipts",
    "/foundry/repos",
    "/foundry/runs",
    "/foundry/verification",
    "/identity",
    "/identity/audit",
    "/identity/authz-check",
    "/identity/business-units",
    "/identity/capabilities",
    "/identity/capability-graph",
    "/identity/dashboard",
    "/identity/login",
    "/identity/oidc/callback?error=access_denied",
    "/identity/permissions",
    "/identity/roles",
    "/identity/sharing-grants",
    "/identity/teams",
    "/identity/users",
    "/identity/variables",
    "/audit",
    "/audit/curation",
    "/engine",
    "/cost",
    "/llm-settings",
    "/learning",
    "/runners",
]

API_COMPAT_ROUTES = [
    "/api/workgraph/workflow-templates?size=1",
    "/workflows/api/workflow-templates?size=1",
    "/workflow/api/workflow-templates?size=1",
    "/workflow/api/runs?mine=true",
    "/workflow/api/connectors",
    "/workflow/api/metadata-definitions",
    "/workflow/api/work-items?size=1",
    "/workbench/api/blueprint/sessions",
    "/foundry/api/codegen/runs?take=1",
]

OPTIONAL_JSON_COMPAT_ROUTES = [
    "/api/audit-gov/health",
    "/audit-gov/health",
    "/workbench/audit-gov/health",
]

BAD_PAGE_PATTERNS = [
    re.compile(r"Could not load this surface", re.I),
    re.compile(r"Could not load Workbench", re.I),
    re.compile(r"Unexpected token", re.I),
    re.compile(r"Internal Server Error", re.I),
    re.compile(r"This unified route is reserved", re.I),
    re.compile(r"reserved for the native .* migration", re.I),
]

LEGACY_LINK_PATTERNS_BY_ROUTE = {
    "/runtime-executions": [
        re.compile(r"NEXT_PUBLIC_WORKGRAPH_WEB_URL", re.I),
        re.compile(r"http://localhost:5174", re.I),
        re.compile(r"target=\"_blank\"[^>]*(?:Open Runs|Workflow Manager)", re.I),
    ],
}

LEGACY_REDIRECTS = [
    RouteExpectation("/agent-studio", 307, "/agents/studio"),
    RouteExpectation("/agent/agent-studio", 307, "/agents/studio"),
    RouteExpectation("/agent-templates", 307, "/agents/studio"),
    RouteExpectation("/login", 307, "/identity/login"),
    RouteExpectation("/context-picker", 307, "/identity/dashboard"),
    RouteExpectation("/dashboard", 307, "/"),
    RouteExpectation("/planner", 307, "/workflows/planner"),
    RouteExpectation("/runtime", 307, "/workflows/inbox"),
    RouteExpectation("/runtime/history", 307, "/workflows/history"),
    RouteExpectation("/runtime/work/task/abc", 307, "/workflows/work/task/abc"),
    RouteExpectation("/templates", 307, "/workflows/templates"),
    RouteExpectation("/templates/abc", 307, "/workflows/templates"),
    RouteExpectation("/workflow", 307, "/workflows"),
    RouteExpectation("/workflow/planner", 307, "/workflows/planner"),
    RouteExpectation("/workflow/runtime", 307, "/workflows/inbox"),
    RouteExpectation("/workflow/runtime/history", 307, "/workflows/history"),
    RouteExpectation("/workflow/runtime/work/task/abc", 307, "/workflows/work/task/abc"),
    RouteExpectation("/workflow/run", 307, "/workflows/run"),
    RouteExpectation("/workflow/workflows", 307, "/workflows/templates"),
    RouteExpectation("/workflow/templates", 307, "/workflows/templates"),
    RouteExpectation("/workflow/node-types", 307, "/workflows/node-types"),
    RouteExpectation("/workflow/design/abc", 307, "/workflows/design/abc"),
    RouteExpectation("/workflow/runs", 307, "/runs"),
    RouteExpectation("/workflow/runs/abc", 307, "/runs/abc"),
    RouteExpectation("/workflow/runs/abc/artifacts", 307, "/runs/abc/artifacts"),
    RouteExpectation("/workflow/runs/abc/insights", 307, "/runs/abc/insights"),
    RouteExpectation("/workflow/artifacts-explorer", 307, "/workflows/artifacts/explorer"),
    RouteExpectation("/workflow/artifacts", 307, "/workflows/artifacts"),
    RouteExpectation("/workflow/artifacts/abc", 307, "/workflows/artifacts/abc"),
    RouteExpectation("/workflow/mission-control/abc", 307, "/runs/abc/insights"),
    RouteExpectation("/workflow/play/new", 307, "/workflows/run"),
    RouteExpectation("/workflow/play/abc", 307, "/runs/abc"),
    RouteExpectation("/workflow/connectors", 307, "/workflows/connectors"),
    RouteExpectation("/workflow/llm-routing", 307, "/llm-settings"),
    RouteExpectation("/workflow/audit", 307, "/audit"),
    RouteExpectation("/workflow/curation", 307, "/audit/curation"),
    RouteExpectation("/workflow/metadata", 307, "/workflows/metadata"),
    RouteExpectation("/workflow/history", 307, "/workflows/history"),
    RouteExpectation("/workflow/team-variables", 307, "/identity/variables"),
    RouteExpectation("/workflow/global-variables", 307, "/identity/variables"),
    RouteExpectation("/workflow/abc", 307, "/runs/abc"),
    RouteExpectation("/workflows/workflows", 307, "/workflows/templates"),
    RouteExpectation("/workflows/runs", 307, "/runs"),
    RouteExpectation("/workflows/runs/abc", 307, "/runs/abc"),
    RouteExpectation("/history", 307, "/workflows/history"),
    RouteExpectation("/design/abc", 307, "/workflows/design/abc"),
    RouteExpectation("/node-types", 307, "/workflows/node-types"),
    RouteExpectation("/artifacts-explorer", 307, "/workflows/artifacts/explorer"),
    RouteExpectation("/artifacts", 307, "/workflows/artifacts"),
    RouteExpectation("/artifacts/abc", 307, "/workflows/artifacts/abc"),
    RouteExpectation("/mission-control/abc", 307, "/runs/abc/insights"),
    RouteExpectation("/play/new", 307, "/workflows/run"),
    RouteExpectation("/play/abc", 307, "/runs/abc"),
    RouteExpectation("/connectors", 307, "/workflows/connectors"),
    RouteExpectation("/metadata", 307, "/workflows/metadata"),
    RouteExpectation("/llm-routing", 307, "/llm-settings"),
    RouteExpectation("/curation", 307, "/audit/curation"),
    RouteExpectation("/team-variables", 307, "/identity/variables"),
    RouteExpectation("/global-variables", 307, "/identity/variables"),
]


def check_page(base_url: str, path: str, timeout: float) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}{path}"
    try:
        with urlopen(Request(url), timeout=timeout) as response:
            ok = response.status == 200
            body = response.read(512_000).decode("utf-8", "replace")
    except HTTPError as exc:
        return False, f"{exc.code} {path}"
    except (OSError, URLError, TimeoutError) as exc:
        return False, f"ERR {path} {exc}"

    for pattern in BAD_PAGE_PATTERNS:
        match = pattern.search(body)
        if match:
            snippet = body[max(0, match.start() - 80): match.end() + 120]
            snippet = re.sub(r"\s+", " ", snippet).strip()
            return False, f"{response.status} {path} bad body: {snippet[:220]}"
    for route_prefix, patterns in LEGACY_LINK_PATTERNS_BY_ROUTE.items():
        if path.startswith(route_prefix):
            for pattern in patterns:
                match = pattern.search(body)
                if match:
                    snippet = body[max(0, match.start() - 80): match.end() + 120]
                    snippet = re.sub(r"\s+", " ", snippet).strip()
                    return False, f"{response.status} {path} legacy link: {snippet[:220]}"
    return ok, f"{response.status} {path}"


def check_json_response(
    base_url: str,
    path: str,
    timeout: float,
    *,
    allow_statuses: set[int] | None = None,
) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}{path}"
    try:
        with urlopen(Request(url), timeout=timeout) as response:
            status = response.status
            content_type = response.headers.get("content-type", "")
            body = response.read(512_000).decode("utf-8", "replace")
    except HTTPError as exc:
        status = exc.code
        content_type = exc.headers.get("content-type", "")
        body = exc.read(512_000).decode("utf-8", "replace")
    except (OSError, URLError, TimeoutError) as exc:
        return False, f"ERR {path} {exc}"

    if allow_statuses is None:
        allow_statuses = set(range(200, 300))
    ok = status in allow_statuses and "json" in content_type.lower()
    if ok:
        try:
            json.loads(body or "{}")
        except json.JSONDecodeError as exc:
            ok = False
            body = f"invalid JSON: {exc}; body={body[:220]}"
    if ok and body.lstrip().startswith("Internal Server Error"):
        ok = False
    return ok, f"{status} {path} {content_type or '-'}"


def check_redirect(base_url: str, expected: RouteExpectation, timeout: float) -> tuple[bool, str]:
    opener = build_opener(NoRedirect)
    url = f"{base_url.rstrip('/')}{expected.path}"
    try:
        response = opener.open(Request(url), timeout=timeout)
        status = response.status
        location = response.headers.get("location", "")
    except HTTPError as exc:
        status = exc.code
        location = exc.headers.get("location", "")
    except (OSError, URLError, TimeoutError) as exc:
        return False, f"ERR {expected.path} {exc}"

    ok = status == expected.status and location == expected.location
    return ok, f"{status} {expected.path} -> {location or '-'}"


def discover_workflow_run_id(base_url: str, timeout: float) -> str | None:
    url = f"{base_url.rstrip('/')}/api/workgraph/workflow-instances?size=1"
    try:
        with urlopen(Request(url), timeout=timeout) as response:
            data = json.loads(response.read(512_000).decode("utf-8", "replace") or "{}")
    except (HTTPError, OSError, URLError, TimeoutError, json.JSONDecodeError):
        return None
    rows = data if isinstance(data, list) else []
    if isinstance(data, dict):
        for key in ("content", "items", "data", "runs", "instances"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("id"), str):
            return row["id"]
    return None


def run_checks(base_url: str, timeout: float, *, allow_api_unavailable: bool = False) -> int:
    failures = 0
    canonical_routes = list(CANONICAL_ROUTES)
    if run_id := discover_workflow_run_id(base_url, timeout):
        canonical_routes.extend([
            f"/runs/{run_id}",
            f"/runs/{run_id}/artifacts",
            f"/runs/{run_id}/insights",
        ])

    for route in canonical_routes:
        ok, message = check_page(base_url, route, timeout)
        print(("OK  " if ok else "FAIL ") + message)
        failures += 0 if ok else 1

    # API probes run without a browser session. User-scoped proxies may
    # correctly enforce auth with structured JSON 401/403 responses; this check
    # is guarding route/proxy shape, JSON parsing, and no raw upstream HTML.
    api_statuses = {200, 401, 403, 502, 503} if allow_api_unavailable else {200, 401, 403}
    optional_api_statuses = {200, 401, 403, 404, 502, 503} if allow_api_unavailable else {200, 401, 403, 404, 502, 503}

    for route in API_COMPAT_ROUTES:
        ok, message = check_json_response(base_url, route, timeout, allow_statuses=api_statuses)
        print(("OK  " if ok else "FAIL ") + message)
        failures += 0 if ok else 1

    for route in OPTIONAL_JSON_COMPAT_ROUTES:
        ok, message = check_json_response(base_url, route, timeout, allow_statuses=optional_api_statuses)
        print(("OK  " if ok else "FAIL ") + message)
        failures += 0 if ok else 1

    for route in LEGACY_REDIRECTS:
        ok, message = check_redirect(base_url, route, timeout)
        print(("OK  " if ok else "FAIL ") + message)
        failures += 0 if ok else 1

    if failures:
        print(f"\n{failures} platform-web route check(s) failed.", file=sys.stderr)
        return 1
    print("\nPlatform Web route checks passed.")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--timeout", type=float, default=5)
    parser.add_argument(
        "--allow-api-unavailable",
        action="store_true",
        help="accept structured JSON auth/unavailable responses for API proxies while still checking pages and redirects",
    )
    args = parser.parse_args(argv)
    return run_checks(args.base_url, args.timeout, allow_api_unavailable=args.allow_api_unavailable)


if __name__ == "__main__":
    raise SystemExit(main())
