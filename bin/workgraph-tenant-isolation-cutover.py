#!/usr/bin/env python3
"""One-command Workgraph tenant DB cutover.

Dry-run is the default. With --apply, this performs the production sequence:

1. Backfill Workgraph tenant spine data using the admin/owner URL.
2. Apply the checked-in tenant RLS policy scaffold.
3. Enable and FORCE RLS on tenant-sensitive Workgraph tables.
4. Run postflight checks through the non-bypass runtime app role.
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
BACKFILL = ROOT / "bin/backfill-workgraph-tenant-ids.py"
ENABLE_RLS = ROOT / "bin/enable-workgraph-forced-rls.py"


def config_value(dotted: str) -> str:
    if not CONFIG.exists():
        return ""
    try:
        data = json.loads(CONFIG.read_text())
    except Exception:
        return ""
    cur: object = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return ""
        cur = cur[part]
    return cur if isinstance(cur, str) else ""


def runtime_database_url(explicit: str | None) -> str:
    return (
        explicit
        or os.getenv("WORKGRAPH_RUNTIME_DATABASE_URL")
        or os.getenv("WORKGRAPH_DATABASE_URL")
        or os.getenv("DATABASE_URL_WORKGRAPH")
        or config_value("services.workgraphRuntimeDatabaseUrl")
        or config_value("services.workgraphDatabaseUrl")
        or ""
    )


def admin_database_url(explicit: str | None) -> str:
    return (
        explicit
        or os.getenv("WORKGRAPH_DATABASE_URL_ADMIN")
        or os.getenv("DATABASE_URL_WORKGRAPH_ADMIN")
        or config_value("services.workgraphAdminDatabaseUrl")
        or ""
    )


def run_step(label: str, cmd: list[str]) -> int:
    print(f"\n==> {label}", flush=True)
    print("+ " + " ".join(shell_quote(part) for part in cmd), flush=True)
    result = subprocess.run(cmd, cwd=ROOT, text=True, check=False)
    if result.returncode != 0:
        print(f"FAIL {label} exited {result.returncode}", file=sys.stderr, flush=True)
    return result.returncode


def shell_quote(value: str) -> str:
    if value == "":
        return "''"
    if all(ch.isalnum() or ch in "@%_+=:,./-" for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def strict_runtime_configured() -> bool:
    return os.getenv("TENANT_ISOLATION_MODE", "").strip().lower() == "strict" and os.getenv(
        "REQUIRE_TENANT_ID",
        "",
    ).strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-database-url", help="Workgraph runtime/app-role DB URL for checks.")
    parser.add_argument("--admin-database-url", help="Workgraph owner/admin DB URL for backfill and RLS DDL.")
    parser.add_argument("--default-tenant-id", help="Tenant id for legacy rows that cannot be inferred.")
    parser.add_argument("--apply", action="store_true", help="Mutate the database. Default is dry-run only.")
    parser.add_argument(
        "--confirm-strict-runtime",
        action="store_true",
        help="Confirm services are configured with TENANT_ISOLATION_MODE=strict and REQUIRE_TENANT_ID=true.",
    )
    args = parser.parse_args()

    runtime_url = runtime_database_url(args.runtime_database_url)
    admin_url = admin_database_url(args.admin_database_url)
    if not runtime_url:
        raise SystemExit("FAIL Workgraph runtime database URL not provided")
    if not admin_url:
        raise SystemExit("FAIL Workgraph admin database URL not provided")
    if not BACKFILL.exists():
        raise SystemExit("FAIL missing bin/backfill-workgraph-tenant-ids.py")
    if not ENABLE_RLS.exists():
        raise SystemExit("FAIL missing bin/enable-workgraph-forced-rls.py")
    if args.apply and not (args.confirm_strict_runtime or strict_runtime_configured()):
        raise SystemExit(
            "FAIL refusing to apply until strict runtime is confirmed; set TENANT_ISOLATION_MODE=strict "
            "and REQUIRE_TENANT_ID=true in this shell or pass --confirm-strict-runtime"
        )

    print("Workgraph tenant isolation cutover", flush=True)
    print(f"mode: {'apply' if args.apply else 'dry-run'}", flush=True)
    print(f"runtime db: {runtime_url}", flush=True)
    print(f"admin db:   {admin_url}", flush=True)

    backfill_cmd = [
        sys.executable,
        str(BACKFILL),
        "--database-url",
        admin_url,
    ]
    if args.default_tenant_id:
        backfill_cmd.extend(["--default-tenant-id", args.default_tenant_id])
    if args.apply:
        backfill_cmd.append("--apply")

    if run_step("backfill tenant spine", backfill_cmd) != 0:
        return 1

    rls_cmd = [
        sys.executable,
        str(ENABLE_RLS),
        "--database-url",
        runtime_url,
        "--admin-database-url",
        admin_url,
    ]
    if args.apply:
        rls_cmd.extend(["--apply", "--confirm-strict-runtime"])

    if run_step("force Workgraph tenant RLS", rls_cmd) != 0:
        return 1

    if not args.apply:
        print("\nDry-run complete. Re-run with --apply --confirm-strict-runtime after reviewing the output.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
