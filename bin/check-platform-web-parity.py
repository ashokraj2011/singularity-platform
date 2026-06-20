#!/usr/bin/env python3
"""Check that legacy July UI paths are represented in Platform Web.

This is intentionally route-level: it proves old bookmarks and app-switcher
targets land on the unified UI. Deeper workflow behavior is covered by the
workflow/workbench/foundry/agent lifecycle smokes.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


@dataclass(frozen=True)
class LegacySurface:
    source: str
    path: str
    expected_status: int
    expected_location: str | None = None
    must_contain: tuple[str, ...] = ()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):  # type: ignore[override]
        return None


LEGACY_SURFACES: list[LegacySurface] = [
    # singularity-portal/src/App.tsx
    LegacySurface("portal", "/", 200, must_contain=("Singularity",)),
    LegacySurface("portal", "/operations", 200, must_contain=("Operations",)),
    LegacySurface("portal", "/engine", 200, must_contain=("Singularity Engine",)),
    LegacySurface("portal", "/login", 307, "/identity/login"),

    # UserAndCapabillity/src/App.tsx, formerly mounted at /iam.
    LegacySurface("iam", "/iam", 307, "/identity"),
    LegacySurface("iam", "/iam/dashboard", 307, "/identity/dashboard"),
    LegacySurface("iam", "/iam/users", 307, "/identity/users"),
    LegacySurface("iam", "/iam/users/abc", 307, "/identity/users/abc"),
    LegacySurface("iam", "/iam/business-units", 307, "/identity/business-units"),
    LegacySurface("iam", "/iam/teams", 307, "/identity/teams"),
    LegacySurface("iam", "/iam/teams/abc", 307, "/identity/teams/abc"),
    LegacySurface("iam", "/iam/capabilities", 307, "/identity/capabilities"),
    LegacySurface("iam", "/iam/capabilities/abc", 307, "/identity/capabilities/abc"),
    LegacySurface("iam", "/iam/capability-graph", 307, "/identity/capability-graph"),
    LegacySurface("iam", "/iam/roles", 307, "/identity/roles"),
    LegacySurface("iam", "/iam/roles/platform-admin", 307, "/identity/roles/platform-admin"),
    LegacySurface("iam", "/iam/permissions", 307, "/identity/permissions"),
    LegacySurface("iam", "/iam/sharing-grants", 307, "/identity/sharing-grants"),
    LegacySurface("iam", "/iam/authz-check", 307, "/identity/authz-check"),
    LegacySurface("iam", "/iam/audit", 307, "/identity/audit"),

    # workgraph-studio/apps/web/src/App.tsx
    LegacySurface("workgraph", "/dashboard", 307, "/"),
    LegacySurface("workgraph", "/context-picker", 307, "/identity/dashboard"),
    LegacySurface("workgraph", "/planner", 307, "/workflows/planner"),
    LegacySurface("workgraph", "/runtime", 307, "/workflows/inbox"),
    LegacySurface("workgraph", "/runtime/history", 307, "/workflows/history"),
    LegacySurface("workgraph", "/runtime/work/task/abc", 307, "/workflows/work/task/abc"),
    LegacySurface("workgraph", "/workflows/planner", 200, must_contain=("Planner",)),
    LegacySurface("workgraph", "/workflows/inbox", 200, must_contain=("Inbox",)),
    LegacySurface("workgraph", "/workflows/work/task/abc", 200, must_contain=("Back to inbox",)),
    LegacySurface("workgraph", "/work-items", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/run", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/workflows", 200, must_contain=("Workflows",)),
    LegacySurface("workgraph", "/templates", 307, "/workflows/templates"),
    LegacySurface("workgraph", "/node-types", 307, "/workflows/node-types"),
    LegacySurface("workgraph", "/design/abc", 307, "/workflows/design/abc"),
    LegacySurface("workgraph", "/workflow", 307, "/workflows"),
    LegacySurface("workgraph", "/workflow/planner", 307, "/workflows/planner"),
    LegacySurface("workgraph", "/workflow/runtime", 307, "/workflows/inbox"),
    LegacySurface("workgraph", "/workflow/runtime/history", 307, "/workflows/history"),
    LegacySurface("workgraph", "/workflow/runtime/work/task/abc", 307, "/workflows/work/task/abc"),
    LegacySurface("workgraph", "/workflow/run", 307, "/workflows/run"),
    LegacySurface("workgraph", "/workflow/workflows", 307, "/workflows/templates"),
    LegacySurface("workgraph", "/workflow/templates", 307, "/workflows/templates"),
    LegacySurface("workgraph", "/workflow/node-types", 307, "/workflows/node-types"),
    LegacySurface("workgraph", "/workflow/design/abc", 307, "/workflows/design/abc"),
    LegacySurface("workgraph", "/workflow/runs", 307, "/runs"),
    LegacySurface("workgraph", "/workflow/runs/abc", 307, "/runs/abc"),
    LegacySurface("workgraph", "/workflow/runs/abc/artifacts", 307, "/runs/abc/artifacts"),
    LegacySurface("workgraph", "/workflow/runs/abc/insights", 307, "/runs/abc/insights"),
    LegacySurface("workgraph", "/workflow/artifacts-explorer", 307, "/workflows/artifacts/explorer"),
    LegacySurface("workgraph", "/workflow/artifacts", 307, "/workflows/artifacts"),
    LegacySurface("workgraph", "/workflow/artifacts/abc", 307, "/workflows/artifacts/abc"),
    LegacySurface("workgraph", "/workflow/mission-control/abc", 307, "/runs/abc/insights"),
    LegacySurface("workgraph", "/workflow/play/new", 307, "/workflows/run"),
    LegacySurface("workgraph", "/workflow/play/abc", 307, "/runs/abc"),
    LegacySurface("workgraph", "/workflow/connectors", 307, "/workflows/connectors"),
    LegacySurface("workgraph", "/workflow/llm-routing", 307, "/llm-settings"),
    LegacySurface("workgraph", "/workflow/audit", 307, "/audit"),
    LegacySurface("workgraph", "/workflow/curation", 307, "/audit/curation"),
    LegacySurface("workgraph", "/workflow/metadata", 307, "/workflows/metadata"),
    LegacySurface("workgraph", "/workflow/history", 307, "/workflows/history"),
    LegacySurface("workgraph", "/workflow/team-variables", 307, "/identity/variables"),
    LegacySurface("workgraph", "/workflow/global-variables", 307, "/identity/variables"),
    LegacySurface("workgraph", "/workflow/abc", 307, "/runs/abc"),
    LegacySurface("workgraph", "/workflows/workflows", 307, "/workflows/templates"),
    LegacySurface("workgraph", "/workflows/runs", 307, "/runs"),
    LegacySurface("workgraph", "/workflows/runs/abc", 307, "/runs/abc"),
    LegacySurface("workgraph", "/runs", 200, must_contain=("Runs",)),
    LegacySurface("workgraph", "/runs/abc", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/artifacts-explorer", 307, "/workflows/artifacts/explorer"),
    LegacySurface("workgraph", "/artifacts", 307, "/workflows/artifacts"),
    LegacySurface("workgraph", "/artifacts/abc", 307, "/workflows/artifacts/abc"),
    LegacySurface("workgraph", "/workflows/artifacts/abc", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/runs/abc/artifacts", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/runs/abc/insights", 200, must_contain=("Singularity",)),
    LegacySurface("workgraph", "/mission-control/abc", 307, "/runs/abc/insights"),
    LegacySurface("workgraph", "/play/new", 307, "/workflows/run"),
    LegacySurface("workgraph", "/play/abc", 307, "/runs/abc"),
    LegacySurface("workgraph", "/connectors", 307, "/workflows/connectors"),
    LegacySurface("workgraph", "/llm-routing", 307, "/llm-settings"),
    LegacySurface("workgraph", "/audit", 200, must_contain=("Audit",)),
    LegacySurface("workgraph", "/curation", 307, "/audit/curation"),
    LegacySurface("workgraph", "/audit/curation", 200, must_contain=("Eval Curation",)),
    LegacySurface("workgraph", "/metadata", 307, "/workflows/metadata"),
    LegacySurface("workgraph", "/history", 307, "/workflows/history"),
    LegacySurface("workgraph", "/team-variables", 307, "/identity/variables"),
    LegacySurface("workgraph", "/global-variables", 307, "/identity/variables"),
    LegacySurface("workgraph", "/identity/variables", 200, must_contain=("Variables",)),

    # agent-and-tools/web July routes, still expected as native Platform Web.
    LegacySurface("agent-web", "/agents", 200, must_contain=("Agents",)),
    LegacySurface("agent-web", "/agent-studio", 307, "/agents/studio"),
    LegacySurface("agent-web", "/agent-templates", 307, "/agents/studio"),
    LegacySurface("agent-web", "/capabilities", 200, must_contain=("Capabilities",)),
    LegacySurface("agent-web", "/tools", 200, must_contain=("Tools",)),
    LegacySurface("agent-web", "/prompt-workbench", 200, must_contain=("Prompt Workbench",)),
    LegacySurface("agent-web", "/runtime-executions", 200, must_contain=("Runtime",)),
    LegacySurface("agent-web", "/memory", 200, must_contain=("Memory",)),

    # code-foundry-web had a single local cockpit route; unified route is native.
    LegacySurface("foundry", "/foundry", 200, must_contain=("Code Foundry",)),
]


def check(base_url: str, item: LegacySurface, timeout: float) -> tuple[bool, str]:
    url = f"{base_url.rstrip('/')}{item.path}"
    if item.expected_status in {301, 302, 303, 307, 308}:
        opener = build_opener(NoRedirect)
        try:
            response = opener.open(Request(url), timeout=timeout)
            status = response.status
            location = response.headers.get("location", "")
            body = ""
        except HTTPError as exc:
            status = exc.code
            location = exc.headers.get("location", "")
            body = exc.read(2048).decode("utf-8", "replace")
        except (OSError, URLError, TimeoutError) as exc:
            return False, f"ERR {item.source} {item.path}: {exc}"
        ok = status == item.expected_status and location == item.expected_location
        return ok, f"{status} {item.source} {item.path} -> {location or '-'}"

    try:
        with urlopen(Request(url), timeout=timeout) as response:
            status = response.status
            body = response.read(512_000).decode("utf-8", "replace")
    except HTTPError as exc:
        return False, f"{exc.code} {item.source} {item.path}"
    except (OSError, URLError, TimeoutError) as exc:
        return False, f"ERR {item.source} {item.path}: {exc}"

    missing = [needle for needle in item.must_contain if needle not in body]
    ok = status == item.expected_status and not missing
    suffix = f" missing={','.join(missing)}" if missing else ""
    return ok, f"{status} {item.source} {item.path}{suffix}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()

    failures: list[str] = []
    for item in LEGACY_SURFACES:
        ok, message = check(args.base_url, item, args.timeout)
        print(("OK  " if ok else "FAIL ") + message)
        if not ok:
            failures.append(message)

    if failures:
        print(f"\n{len(failures)} Platform Web parity check(s) failed.", file=sys.stderr)
        return 1
    print("\nPlatform Web July parity checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
