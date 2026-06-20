#!/usr/bin/env python3
"""Check Workgraph database tenant-isolation posture.

This guard is intentionally split into two layers:

1. Source/schema checks that are safe everywhere and prove the Prisma model still
   exposes the tenant spine used by runtime rows.
2. Optional live Postgres checks that prove a target database has no unscoped
   runtime data and, when requested, has RLS forced on tenant-sensitive tables.

The default mode is non-disruptive for local development. Production/deploy
preflight can pass --require-db/--strict-data/--require-rls to fail closed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "workgraph-studio/apps/api/prisma/schema.prisma"
CONFIG = ROOT / ".singularity/config.local.json"
RLS_MIGRATION = ROOT / "workgraph-studio/apps/api/prisma/migrations/20260619123000_tenant_rls_policy_scaffold/migration.sql"


@dataclass(frozen=True)
class TenantTable:
    table: str
    instance_column: str | None
    nullable_instance: bool = False
    require_rls: bool = True
    tenant_column: str | None = None


TENANT_TABLES = [
    TenantTable("workflow_instances", None, tenant_column="tenantId"),
    TenantTable("run_snapshots", None, tenant_column="tenantId"),
    TenantTable("workflow_run_budgets", "instanceId"),
    TenantTable("workflow_run_budget_events", "instanceId"),
    TenantTable("workflow_phases", "instanceId"),
    TenantTable("workflow_nodes", "instanceId"),
    TenantTable("workflow_edges", "instanceId"),
    TenantTable("workflow_mutations", "instanceId"),
    TenantTable("workflow_events", "instanceId"),
    TenantTable("tasks", "instanceId", nullable_instance=True),
    TenantTable("approval_requests", "instanceId", nullable_instance=True),
    TenantTable("consumables", "instanceId", nullable_instance=True),
    TenantTable("agent_runs", "instanceId", nullable_instance=True),
    TenantTable("tool_runs", "instanceId", nullable_instance=True),
    TenantTable("documents", "instanceId", nullable_instance=True),
    TenantTable("pending_executions", "instanceId"),
]


class Reporter:
    def __init__(self, as_json: bool) -> None:
        self.as_json = as_json
        self.records: list[dict[str, str]] = []
        self.failures = 0
        self.warnings = 0

    def emit(self, status: str, message: str) -> None:
        self.records.append({"status": status, "message": message})
        if status == "FAIL":
            self.failures += 1
        if status == "WARN":
            self.warnings += 1
        if not self.as_json:
            stream = sys.stderr if status == "FAIL" else sys.stdout
            print(f"{status:<4} {message}", file=stream)

    def finish(self) -> int:
        if self.as_json:
            print(json.dumps({"failures": self.failures, "warnings": self.warnings, "records": self.records}, indent=2))
        return 1 if self.failures else 0


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


def load_schema() -> str:
    return SCHEMA.read_text()


def check_source_schema(reporter: Reporter) -> None:
    if not SCHEMA.exists():
        reporter.emit("FAIL", f"missing Workgraph Prisma schema: {SCHEMA.relative_to(ROOT)}")
        return
    schema = load_schema()
    workflow_instance = re.search(r"model\s+WorkflowInstance\s+\{(?P<body>.*?)\n\}", schema, re.S)
    if not workflow_instance:
        reporter.emit("FAIL", "WorkflowInstance model is missing")
        return
    body = workflow_instance.group("body")
    if not re.search(r"^\s*tenantId\s+String\?", body, re.M):
        reporter.emit("FAIL", "WorkflowInstance.tenantId must exist as a first-class tenant spine")
    else:
        reporter.emit("OK", "WorkflowInstance.tenantId exists")
    if '@@index([tenantId])' not in body:
        reporter.emit("FAIL", "WorkflowInstance.tenantId must remain indexed")
    else:
        reporter.emit("OK", "WorkflowInstance.tenantId index exists")

    run_snapshot = re.search(r"model\s+RunSnapshot\s+\{(?P<body>.*?)\n\}", schema, re.S)
    if not run_snapshot:
        reporter.emit("FAIL", "RunSnapshot model is missing")
    else:
        snapshot_body = run_snapshot.group("body")
        if not re.search(r"^\s*tenantId\s+String\?", snapshot_body, re.M):
            reporter.emit("FAIL", "RunSnapshot.tenantId must exist as a first-class tenant spine")
        else:
            reporter.emit("OK", "RunSnapshot.tenantId exists")
        if '@@index([tenantId])' not in snapshot_body:
            reporter.emit("FAIL", "RunSnapshot.tenantId must remain indexed")
        else:
            reporter.emit("OK", "RunSnapshot.tenantId index exists")

    for table in TENANT_TABLES:
        if f'@@map("{table.table}")' not in schema:
            reporter.emit("FAIL", f"tenant-sensitive table missing from Prisma schema: {table.table}")
    reporter.emit("OK", f"{len(TENANT_TABLES)} tenant-sensitive Workgraph tables are present in schema")

    if not RLS_MIGRATION.exists():
        reporter.emit("FAIL", f"missing tenant RLS policy scaffold migration: {RLS_MIGRATION.relative_to(ROOT)}")
    else:
        migration = RLS_MIGRATION.read_text()
        required_terms = ["workgraph_current_tenant_id", "workgraph_instance_visible", "tenant_isolation_policy"]
        missing_terms = [term for term in required_terms if term not in migration]
        if missing_terms:
            reporter.emit("FAIL", "tenant RLS policy scaffold migration is missing: " + ", ".join(missing_terms))
        else:
            reporter.emit("OK", "tenant RLS policy scaffold migration exists")


def psql(database_url: str, sql: str) -> str:
    result = subprocess.run(
        ["psql", database_url, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError(detail[0] if detail else "psql failed")
    return result.stdout.strip()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def check_live_database(
    reporter: Reporter,
    database_url: str,
    *,
    require_db: bool,
    strict_data: bool,
    require_rls: bool,
) -> None:
    if not database_url:
        reporter.emit("FAIL" if require_db else "WARN", "Workgraph database URL not provided; live tenant DB checks skipped")
        return
    try:
        version = psql(database_url, "select current_database() || ' on ' || split_part(version(), ' ', 2)")
    except Exception as exc:
        reporter.emit("FAIL" if require_db else "WARN", f"could not connect to Workgraph database; live tenant DB checks skipped: {exc}")
        return
    reporter.emit("OK", f"connected to Workgraph database ({version})")

    role_flags_raw = psql(
        database_url,
        "select current_user || ':' || rolsuper || ':' || rolbypassrls "
        "from pg_roles where rolname = current_user",
    )
    role_name, role_super, role_bypass_rls = role_flags_raw.split(":")
    is_super = role_super in {"t", "true", "1"}
    bypasses_rls = role_bypass_rls in {"t", "true", "1"}
    if is_super or bypasses_rls:
        status = "FAIL" if require_rls else "WARN"
        flags = []
        if is_super:
            flags.append("SUPERUSER")
        if bypasses_rls:
            flags.append("BYPASSRLS")
        reporter.emit(
            status,
            f"connected Workgraph DB role {role_name} has {'+'.join(flags)}; forced RLS requires an app role that cannot bypass row security",
        )
    else:
        reporter.emit("OK", f"connected Workgraph DB role {role_name} cannot bypass RLS")

    table_names = ", ".join(sql_literal(table.table) for table in TENANT_TABLES)
    existing_raw = psql(
        database_url,
        f"select table_name from information_schema.tables where table_schema='public' and table_name in ({table_names})",
    )
    existing = {line.strip() for line in existing_raw.splitlines() if line.strip()}
    for table in TENANT_TABLES:
        if table.table not in existing:
            reporter.emit("FAIL", f"tenant-sensitive table missing in live database: {table.table}")
    if reporter.failures:
        return

    tenant_column_count = psql(
        database_url,
        "select count(*) from information_schema.columns where table_schema='public' "
        "and table_name='workflow_instances' and column_name='tenantId'",
    )
    if tenant_column_count != "1":
        reporter.emit("FAIL", "workflow_instances.tenantId column missing in live database")
    else:
        reporter.emit("OK", "workflow_instances.tenantId column exists in live database")

    tenant_index_count = psql(
        database_url,
        "select count(*) from pg_indexes where schemaname='public' and tablename='workflow_instances' "
        "and indexdef like '%\"tenantId\"%'",
    )
    if tenant_index_count == "0":
        reporter.emit("FAIL", "workflow_instances.tenantId index missing in live database")
    else:
        reporter.emit("OK", "workflow_instances.tenantId index exists in live database")

    snapshot_tenant_column_count = psql(
        database_url,
        "select count(*) from information_schema.columns where table_schema='public' "
        "and table_name='run_snapshots' and column_name='tenantId'",
    )
    if snapshot_tenant_column_count != "1":
        reporter.emit("FAIL", "run_snapshots.tenantId column missing in live database")
    else:
        reporter.emit("OK", "run_snapshots.tenantId column exists in live database")

    snapshot_tenant_index_count = psql(
        database_url,
        "select count(*) from pg_indexes where schemaname='public' and tablename='run_snapshots' "
        "and indexdef like '%\"tenantId\"%'",
    )
    if snapshot_tenant_index_count == "0":
        reporter.emit("FAIL", "run_snapshots.tenantId index missing in live database")
    else:
        reporter.emit("OK", "run_snapshots.tenantId index exists in live database")

    for table in (table for table in TENANT_TABLES if table.tenant_column):
        unscoped = int(psql(database_url, f'select count(*) from "{table.table}" where "{table.tenant_column}" is null'))
        if unscoped:
            status = "FAIL" if strict_data else "WARN"
            reporter.emit(
                status,
                f"{unscoped} {table.table} row(s) have null {table.tenant_column}; backfill or archive legacy rows before enabling strict tenant isolation",
            )
        else:
            reporter.emit("OK", f"all {table.table} rows have {table.tenant_column}")

    for table in TENANT_TABLES:
        if not table.instance_column:
            continue
        if table.nullable_instance:
            null_instance_count = int(psql(database_url, f'select count(*) from "{table.table}" where "{table.instance_column}" is null'))
            if null_instance_count:
                status = "FAIL" if strict_data else "WARN"
                reporter.emit(
                    status,
                    f"{table.table} has {null_instance_count} row(s) without {table.instance_column}; backfill, attach to a tenant-spined workflow instance, or archive before forced RLS",
                )
        null_clause = f' and child."{table.instance_column}" is not null' if table.nullable_instance else ""
        orphan_sql = (
            f'select count(*) from "{table.table}" child '
            f'left join "workflow_instances" wi on wi.id = child."{table.instance_column}" '
            f'where wi.id is null{null_clause}'
        )
        orphan_count = int(psql(database_url, orphan_sql))
        if orphan_count:
            reporter.emit("FAIL", f"{table.table} has {orphan_count} row(s) without a matching workflow_instances tenant spine")
    reporter.emit("OK", "runtime child rows are connected to workflow_instances")

    rls_rows_raw = psql(
        database_url,
        f"select relname || ':' || relrowsecurity || ':' || relforcerowsecurity "
        f"from pg_class where relnamespace = 'public'::regnamespace and relname in ({table_names})",
    )
    rls_state: dict[str, tuple[bool, bool]] = {}
    for line in rls_rows_raw.splitlines():
        if not line.strip():
            continue
        name, row_security, force_security = line.split(":")
        rls_state[name] = (
            row_security in {"t", "true", "1"},
            force_security in {"t", "true", "1"},
        )
    missing_rls = [table.table for table in TENANT_TABLES if table.require_rls and rls_state.get(table.table) != (True, True)]
    if missing_rls:
        status = "FAIL" if require_rls else "WARN"
        reporter.emit(status, "RLS is not enabled+forced on: " + ", ".join(missing_rls))
    else:
        reporter.emit("OK", "RLS is enabled and forced on tenant-sensitive Workgraph tables")

    policy_rows_raw = psql(
        database_url,
        f"select tablename from pg_policies where schemaname='public' "
        f"and policyname='tenant_isolation_policy' and tablename in ({table_names})",
    )
    policy_tables = {line.strip() for line in policy_rows_raw.splitlines() if line.strip()}
    missing_policies = [table.table for table in TENANT_TABLES if table.require_rls and table.table not in policy_tables]
    function_count = int(psql(
        database_url,
        "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
        "where n.nspname='public' and p.proname in ('workgraph_current_tenant_id', 'workgraph_instance_visible')",
    ))
    if missing_policies or function_count < 2:
        status = "FAIL" if require_rls else "WARN"
        details = []
        if function_count < 2:
            details.append("tenant helper functions missing")
        if missing_policies:
            details.append("policy missing on: " + ", ".join(missing_policies))
        reporter.emit(status, "tenant RLS policy scaffold incomplete in live database: " + "; ".join(details))
    else:
        reporter.emit("OK", "tenant RLS policy scaffold exists in live database")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Workgraph Postgres URL. Defaults to env/config.")
    parser.add_argument("--schema-only", action="store_true", help="Only run source/schema checks.")
    parser.add_argument("--require-db", action="store_true", help="Fail if the live database cannot be checked.")
    parser.add_argument("--strict-data", action="store_true", help="Fail if existing workflow_instances rows have null tenantId.")
    parser.add_argument("--require-rls", action="store_true", help="Fail unless RLS is enabled and forced on tenant-sensitive tables.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    args = parser.parse_args()

    reporter = Reporter(as_json=args.json)
    check_source_schema(reporter)
    if not args.schema_only:
        check_live_database(
            reporter,
            resolve_database_url(args.database_url),
            require_db=args.require_db,
            strict_data=args.strict_data,
            require_rls=args.require_rls,
        )
    return reporter.finish()


if __name__ == "__main__":
    raise SystemExit(main())
