#!/usr/bin/env python3
"""Enable and FORCE tenant RLS on Context Fabric's conversation store.

Mirrors bin/enable-workgraph-forced-rls.py. Like that script this is
intentionally NOT part of local setup: forcing RLS is a production cutover step,
safe only once every read and write of the conversation tables runs inside a
tenant-scoped transaction that sets app.tenant_id.

Conversation turns are raw user text, which is why this store gets the treatment
before most of CF does.

Dry-run by default: prints what it would apply and changes nothing.
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
APP_DIR = ROOT / "context-fabric/services/context_api_service/app"
POLICY_SCAFFOLD = APP_DIR / "sql/conversation_rls_policies.sql"
CUTOVER = APP_DIR / "sql/conversation_rls_cutover.sql"

TENANT_TABLES = ["cf_conversations", "cf_conversation_turns"]

TRUE_VALUES = {"1", "true", "yes", "on"}


def read_config_database_url() -> str:
    if not CONFIG.exists():
        return ""
    try:
        data = json.loads(CONFIG.read_text())
    except Exception:
        return ""
    cur: object = data
    for part in "services.contextFabricDatabaseUrl".split("."):
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(part)
    return cur if isinstance(cur, str) else ""


def resolve_database_url(explicit: str | None) -> str:
    """Same precedence the store itself uses (resolve_database_target), so the
    script cannot cut over a different database than the one CF writes to."""
    return (
        explicit
        or os.getenv("CONVERSATION_STORE_DATABASE_URL")
        or os.getenv("CONTEXT_FABRIC_DATABASE_URL")
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


def strict_runtime_configured() -> bool:
    tenant_mode = os.getenv("TENANT_ISOLATION_MODE", "").strip().lower()
    require_tenant = os.getenv("REQUIRE_TENANT_ID", "").strip().lower()
    return tenant_mode == "strict" and require_tenant in TRUE_VALUES


VERIFY_SQL = """
SELECT c.relname AS table_name,
       c.relrowsecurity AS enabled,
       c.relforcerowsecurity AS forced,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname
           AND p.policyname = 'tenant_isolation_policy') AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('cf_conversations', 'cf_conversation_turns')
 ORDER BY c.relname;
"""


def verify(database_url: str, *, require_forced: bool) -> int:
    """Report policy/enabled/forced per table.

    `forced` is checked separately from `enabled` on purpose: ENABLE alone leaves
    the table owner bypassing its own policies, so a table can look protected in
    pg_policies and isolate nothing at runtime.
    """
    result = psql(database_url, ["-A", "-F", "|", "-t", "-c", VERIFY_SQL])
    if result.returncode != 0:
        print((result.stderr or result.stdout).strip(), file=sys.stderr)
        return 1

    rows = [line for line in result.stdout.strip().splitlines() if line.strip()]
    if not rows:
        print("FAIL conversation tables not found; run the service once so init_db() creates them", file=sys.stderr)
        return 1

    seen: set[str] = set()
    failed = False
    for line in rows:
        name, enabled, forced, policies = line.split("|")
        seen.add(name)
        ok_policy = int(policies) > 0
        ok_forced = forced == "t"
        print(
            f"  {name}: policy={'yes' if ok_policy else 'NO'} "
            f"enabled={'yes' if enabled == 't' else 'no'} "
            f"forced={'yes' if ok_forced else 'no'}"
        )
        if not ok_policy:
            print(f"FAIL {name} has no tenant_isolation_policy", file=sys.stderr)
            failed = True
        if require_forced and not ok_forced:
            print(f"FAIL {name} does not have FORCE ROW LEVEL SECURITY", file=sys.stderr)
            failed = True

    for table in TENANT_TABLES:
        if table not in seen:
            print(f"FAIL missing table: {table}", file=sys.stderr)
            failed = True

    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Conversation-store Postgres URL. Defaults to env/config, matching resolve_database_target's precedence.")
    parser.add_argument("--admin-database-url", help="Owner/admin Postgres URL used to apply the scaffold and the cutover. Defaults to --database-url.")
    parser.add_argument("--apply", action="store_true", help="Apply forced RLS. Without this flag, prints the plan and changes nothing.")
    parser.add_argument(
        "--confirm-strict-runtime",
        action="store_true",
        help="Confirm every conversation-store caller runs inside a tenant-scoped transaction.",
    )
    args = parser.parse_args()

    database_url = resolve_database_url(args.database_url)
    if not database_url:
        raise SystemExit("FAIL conversation-store database URL not provided")
    if not database_url.startswith(("postgres://", "postgresql://")):
        # The store also accepts a SQLite path. Cutting over is meaningless
        # there and silently "succeeding" would be the dangerous outcome.
        raise SystemExit(
            f"FAIL conversation RLS requires a Postgres URL; got {database_url!r}. "
            "SQLite has no row-level security."
        )
    admin_database_url = args.admin_database_url or os.getenv("CONTEXT_FABRIC_DATABASE_URL_ADMIN") or database_url

    if not POLICY_SCAFFOLD.exists():
        raise SystemExit(f"FAIL missing policy scaffold: {POLICY_SCAFFOLD}")
    if not CUTOVER.exists():
        raise SystemExit(f"FAIL missing cutover file: {CUTOVER}")

    if args.apply and not (args.confirm_strict_runtime or strict_runtime_configured()):
        raise SystemExit(
            "FAIL refusing to force RLS until strict runtime is confirmed; set TENANT_ISOLATION_MODE=strict "
            "and REQUIRE_TENANT_ID=true in this environment or pass --confirm-strict-runtime"
        )

    if not args.apply:
        print("dry-run only; pass --apply --confirm-strict-runtime to execute")
        print(f"  1. apply policy scaffold: {POLICY_SCAFFOLD.relative_to(ROOT)}")
        print(f"  2. apply guarded cutover: {CUTOVER.relative_to(ROOT)}")
        print(f"     tables: {', '.join(TENANT_TABLES)}")
        print("current state:")
        return verify(database_url, require_forced=False)

    print("applying policy scaffold (inert: no runtime effect on its own)")
    scaffold = psql(admin_database_url, ["-f", str(POLICY_SCAFFOLD)])
    if scaffold.returncode != 0:
        detail = (scaffold.stderr or scaffold.stdout or "").strip()
        raise SystemExit(f"FAIL could not apply RLS scaffold: {detail}")

    print("preflight + cutover (aborts with zero changes if any guard fails)")
    applied = psql(admin_database_url, ["-f", str(CUTOVER)])
    if applied.returncode != 0:
        detail = (applied.stderr or applied.stdout or "").strip()
        raise SystemExit(f"FAIL could not enable forced RLS: {detail}")
    if applied.stderr.strip():
        print(applied.stderr.strip())

    print("postflight: verifying forced tenant RLS")
    return verify(database_url, require_forced=True)


if __name__ == "__main__":
    raise SystemExit(main())
