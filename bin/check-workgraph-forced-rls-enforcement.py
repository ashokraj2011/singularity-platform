#!/usr/bin/env python3
"""Prove Workgraph forced RLS enforces tenant visibility in a throwaway DB.

The smoke creates a temporary database and a temporary non-superuser app role,
installs a minimal Workgraph tenant-sensitive schema, runs the real guarded
forced-RLS cutover, verifies same-tenant reads, cross-tenant hiding, and
cross-tenant write rejection, then drops all temporary objects.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import string
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".singularity/config.local.json"
ENABLE_RLS = ROOT / "bin/enable-workgraph-forced-rls.py"

TENANT_CHILD_TABLES = [
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
        or os.getenv("WORKGRAPH_ADMIN_DATABASE_URL")
        or os.getenv("WORKGRAPH_DATABASE_URL")
        or os.getenv("DATABASE_URL_WORKGRAPH")
        or read_config_database_url()
        or ""
    )


def database_url_with(database_url: str, *, database: str, username: str | None = None, password: str | None = None) -> str:
    parsed = urlsplit(database_url)
    host = parsed.hostname or ""
    netloc = host
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    effective_username = parsed.username if username is None else username
    effective_password = parsed.password if username is None and password is None else password
    if effective_username is not None:
        userinfo = quote(effective_username)
        if effective_password is not None:
            userinfo = f"{userinfo}:{quote(effective_password)}"
        netloc = f"{userinfo}@{netloc}"
    return urlunsplit((parsed.scheme, netloc, "/" + database, parsed.query, parsed.fragment))


def psql(database_url: str, sql: str, *, expect_ok: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["psql", database_url, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if expect_ok and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail or "psql failed")
    return result


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def identifier(prefix: str) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return prefix + "_" + "".join(secrets.choice(alphabet) for _ in range(12))


def minimal_schema_sql() -> str:
    lines = [
        'CREATE TABLE workflow_instances (id text PRIMARY KEY, "tenantId" text);',
        'CREATE INDEX workflow_instances_tenant_idx ON workflow_instances ("tenantId");',
        'CREATE TABLE run_snapshots (id text PRIMARY KEY, "tenantId" text);',
        'CREATE INDEX run_snapshots_tenant_idx ON run_snapshots ("tenantId");',
    ]
    for table in TENANT_CHILD_TABLES:
        lines.append(f'CREATE TABLE "{table}" (id text PRIMARY KEY, "instanceId" text);')
    lines.extend([
        'INSERT INTO workflow_instances (id, "tenantId") VALUES (\'inst_a\', \'tenant_a\'), (\'inst_b\', \'tenant_b\');',
        'INSERT INTO run_snapshots (id, "tenantId") VALUES (\'snap_a\', \'tenant_a\'), (\'snap_b\', \'tenant_b\');',
        'INSERT INTO agent_runs (id, "instanceId") VALUES (\'agent_a\', \'inst_a\'), (\'agent_b\', \'inst_b\');',
        'INSERT INTO tool_runs (id, "instanceId") VALUES (\'tool_a\', \'inst_a\'), (\'tool_b\', \'inst_b\');',
    ])
    return "\n".join(lines)


def runtime_grants_sql(role_name: str, db_name: str) -> str:
    return "\n".join([
        f"GRANT CONNECT ON DATABASE {db_name} TO {role_name};",
        f"GRANT USAGE ON SCHEMA public TO {role_name};",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role_name};",
        f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {role_name};",
        f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {role_name};",
    ])


def scalar(database_url: str, sql: str) -> str:
    return psql(database_url, sql).stdout.strip().splitlines()[-1].strip()


def run_enable_cutover(app_url: str, admin_url: str) -> None:
    env = {
        **os.environ,
        "TENANT_ISOLATION_MODE": "strict",
        "REQUIRE_TENANT_ID": "true",
    }
    result = subprocess.run(
        [sys.executable, str(ENABLE_RLS), "--database-url", app_url, "--admin-database-url", admin_url, "--apply"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail or "forced-RLS cutover failed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Admin-capable Postgres URL. Defaults to Workgraph env/config.")
    args = parser.parse_args()

    admin_url = resolve_database_url(args.database_url)
    if not admin_url:
        print("FAIL Workgraph admin database URL not provided", file=sys.stderr)
        return 1
    if not ENABLE_RLS.exists():
        print(f"FAIL missing {ENABLE_RLS.relative_to(ROOT)}", file=sys.stderr)
        return 1

    db_name = identifier("wg_rls_smoke")
    role_name = identifier("wg_rls_role")
    role_password = "pw_" + secrets.token_urlsafe(24)
    maintenance_url = database_url_with(admin_url, database="postgres")
    app_url = database_url_with(admin_url, database=db_name, username=role_name, password=role_password)
    admin_temp_url = database_url_with(admin_url, database=db_name)

    created_db = False
    created_role = False
    try:
        role_flags_raw = scalar(
            maintenance_url,
            "select rolsuper || ':' || rolcreatedb || ':' || rolcreaterole from pg_roles where rolname = current_user",
        )
        role_super, role_createdb, role_createrole = role_flags_raw.split(":")
        is_super = role_super in {"t", "true", "1"}
        can_create_db = role_createdb in {"t", "true", "1"}
        can_create_role = role_createrole in {"t", "true", "1"}
        if not (is_super or (can_create_db and can_create_role)):
            print("SKIP connected role cannot create throwaway DB/role for forced-RLS enforcement smoke")
            return 0

        psql(maintenance_url, f"CREATE ROLE {role_name} LOGIN PASSWORD {sql_literal(role_password)} NOSUPERUSER NOBYPASSRLS")
        created_role = True
        psql(maintenance_url, f"CREATE DATABASE {db_name}")
        created_db = True
        psql(admin_temp_url, minimal_schema_sql())
        psql(admin_temp_url, runtime_grants_sql(role_name, db_name))
        run_enable_cutover(app_url, admin_temp_url)

        no_tenant_instances = scalar(app_url, "select count(*) from workflow_instances")
        tenant_a_instances = scalar(app_url, "select set_config('app.tenant_id', 'tenant_a', false); select count(*) from workflow_instances")
        tenant_a_agent_runs = scalar(app_url, "select set_config('app.tenant_id', 'tenant_a', false); select count(*) from agent_runs")
        tenant_b_agent_runs = scalar(app_url, "select set_config('app.tenant_id', 'tenant_b', false); select count(*) from agent_runs")
        if (no_tenant_instances, tenant_a_instances, tenant_a_agent_runs, tenant_b_agent_runs) != ("0", "1", "1", "1"):
            raise RuntimeError(
                "unexpected RLS visibility counts: "
                f"no_tenant={no_tenant_instances}, tenant_a_instances={tenant_a_instances}, "
                f"tenant_a_agent_runs={tenant_a_agent_runs}, tenant_b_agent_runs={tenant_b_agent_runs}"
            )

        valid_insert = psql(app_url, "select set_config('app.tenant_id', 'tenant_a', false); insert into agent_runs (id, \"instanceId\") values ('agent_a2', 'inst_a')")
        if valid_insert.returncode != 0:
            raise RuntimeError("same-tenant insert was rejected")
        cross_insert = psql(
            app_url,
            "select set_config('app.tenant_id', 'tenant_a', false); insert into agent_runs (id, \"instanceId\") values ('agent_cross', 'inst_b')",
            expect_ok=False,
        )
        if cross_insert.returncode == 0:
            raise RuntimeError("cross-tenant insert succeeded despite forced RLS")

        print("OK forced RLS hides cross-tenant rows and rejects cross-tenant writes in throwaway Workgraph DB")
        return 0
    except Exception as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    finally:
        if created_db:
            psql(maintenance_url, f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)", expect_ok=False)
        if created_role:
            psql(maintenance_url, f"DROP ROLE IF EXISTS {role_name}", expect_ok=False)


if __name__ == "__main__":
    raise SystemExit(main())
