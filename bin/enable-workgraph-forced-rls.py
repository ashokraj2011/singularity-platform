#!/usr/bin/env python3
"""Enable and FORCE Workgraph tenant RLS after strict-runtime cutover checks.

This script is intentionally not run by default local setup. Forced RLS is a
production cutover step: every tenant-sensitive query path must run inside a
tenant-scoped DB transaction that sets app.tenant_id.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".singularity/config.local.json"
CHECKER = ROOT / "bin/check-workgraph-db-tenant-isolation.py"
RLS_SCAFFOLD = ROOT / "workgraph-studio/apps/api/prisma/migrations/20260619123000_tenant_rls_policy_scaffold/migration.sql"

TENANT_TABLES = [
    "workflow_instances",
    "run_snapshots",
    "workflow_run_budgets",
    "workflow_run_budget_events",
    "workflow_phases",
    "workflow_nodes",
    "workflow_edges",
    "workflow_mutations",
    "workflow_events",
    "tasks",
    "approval_requests",
    "consumables",
    "agent_runs",
    "tool_runs",
    "documents",
    "pending_executions",
]

TRUE_VALUES = {"1", "true", "yes", "on"}


def read_config_database_url() -> str:
    if not CONFIG.exists():
        return ""
    try:
        data = json.loads(CONFIG.read_text())
    except Exception:
        return ""
    cur: object = data
    for part in "services.workgraphDatabaseUrl".split("."):
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(part)
    return cur if isinstance(cur, str) else ""


def resolve_database_url(explicit: str | None) -> str:
    return (
        explicit
        or os.getenv("WORKGRAPH_RUNTIME_DATABASE_URL")
        or os.getenv("WORKGRAPH_DATABASE_URL")
        or os.getenv("DATABASE_URL_WORKGRAPH")
        or read_config_database_url()
        or ""
    )


def psql(database_url: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["psql", database_url, "-X", "-q", "-v", "ON_ERROR_STOP=1", *args],
        text=True,
        capture_output=True,
        check=False,
    )


def run_checker(database_url: str, require_rls: bool) -> int:
    cmd = [
        sys.executable,
        str(CHECKER),
        "--database-url",
        database_url,
        "--require-db",
        "--strict-data",
    ]
    if require_rls:
        cmd.append("--require-rls")
    result = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    output = (result.stdout + result.stderr).strip()
    if output:
        print(output)
    return result.returncode


def strict_runtime_configured() -> bool:
    tenant_mode = os.getenv("TENANT_ISOLATION_MODE", "").strip().lower()
    require_tenant = os.getenv("REQUIRE_TENANT_ID", "").strip().lower()
    return tenant_mode == "strict" and require_tenant in TRUE_VALUES


def enable_sql() -> str:
    lines: list[str] = [
        "-- Enable and force tenant RLS on Workgraph runtime tables.",
        "-- Safe only after application runtime is configured for strict tenant mode.",
    ]
    for table in TENANT_TABLES:
        quoted = '"' + table.replace('"', '""') + '"'
        lines.append(f"ALTER TABLE public.{quoted} ENABLE ROW LEVEL SECURITY;")
        lines.append(f"ALTER TABLE public.{quoted} FORCE ROW LEVEL SECURITY;")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Workgraph app-role Postgres URL used for preflight/postflight checks. Defaults to env/config.")
    parser.add_argument("--admin-database-url", help="Owner/admin Postgres URL used to apply the RLS scaffold and ALTER TABLE cutover. Defaults to --database-url.")
    parser.add_argument("--apply", action="store_true", help="Apply forced RLS. Without this flag, prints the planned SQL.")
    parser.add_argument(
        "--confirm-strict-runtime",
        action="store_true",
        help="Confirm Workgraph/Context Fabric are configured with TENANT_ISOLATION_MODE=strict and REQUIRE_TENANT_ID=true.",
    )
    args = parser.parse_args()

    database_url = resolve_database_url(args.database_url)
    if not database_url:
        raise SystemExit("FAIL Workgraph database URL not provided")
    admin_database_url = args.admin_database_url or os.getenv("WORKGRAPH_DATABASE_URL_ADMIN") or database_url
    if not CHECKER.exists():
        raise SystemExit("FAIL missing bin/check-workgraph-db-tenant-isolation.py")
    if not RLS_SCAFFOLD.exists():
        raise SystemExit("FAIL missing tenant RLS policy scaffold migration")

    if args.apply and not (args.confirm_strict_runtime or strict_runtime_configured()):
        raise SystemExit(
            "FAIL refusing to force RLS until strict runtime is confirmed; set TENANT_ISOLATION_MODE=strict "
            "and REQUIRE_TENANT_ID=true in this environment or pass --confirm-strict-runtime"
        )

    print("preflight: verifying tenant data and policy scaffold")
    if run_checker(database_url, require_rls=False) != 0:
        return 1

    sql = enable_sql()
    if not args.apply:
        print("dry-run only; pass --apply --confirm-strict-runtime to execute")
        print(sql, end="")
        return 0

    scaffold = psql(admin_database_url, ["-f", str(RLS_SCAFFOLD)])
    if scaffold.returncode != 0:
        detail = (scaffold.stderr or scaffold.stdout or "").strip()
        raise SystemExit(f"FAIL could not apply RLS scaffold: {detail}")

    applied = psql(admin_database_url, ["-c", sql])
    if applied.returncode != 0:
        detail = (applied.stderr or applied.stdout or "").strip()
        raise SystemExit(f"FAIL could not enable forced RLS: {detail}")

    print("postflight: verifying forced tenant RLS")
    return run_checker(database_url, require_rls=True)


if __name__ == "__main__":
    raise SystemExit(main())
