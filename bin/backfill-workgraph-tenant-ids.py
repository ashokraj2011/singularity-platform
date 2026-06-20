#!/usr/bin/env python3
"""Backfill Workgraph tenant spine data.

The tool first infers tenant ids from the same JSON locations the runtime uses:
tenantId/tenant_id, _vars, _globals, _workItem, and _workItem.input. Rows that
still cannot be inferred are left untouched unless --default-tenant-id is
provided.

It also repairs nullable runtime child rows that must point at a workflow
instance before forced RLS is safe. The first supported repair is the WorkItem
parent-approval shape: approval_requests created without sourceWorkflowInstanceId
carry child workflow instance evidence under formData.targets.

Mutations require --apply; dry-run is the default.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".singularity/config.local.json"

TENANT_EXPR = """nullif(coalesce(
  context #>> '{tenantId}',
  context #>> '{tenant_id}',
  context #>> '{_vars,tenantId}',
  context #>> '{_vars,tenant_id}',
  context #>> '{vars,tenantId}',
  context #>> '{vars,tenant_id}',
  context #>> '{_globals,tenantId}',
  context #>> '{_globals,tenant_id}',
  context #>> '{globals,tenantId}',
  context #>> '{globals,tenant_id}',
  context #>> '{_workItem,tenantId}',
  context #>> '{_workItem,tenant_id}',
  context #>> '{_workItem,input,tenantId}',
  context #>> '{_workItem,input,tenant_id}'
), '')"""


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
        or os.getenv("WORKGRAPH_DATABASE_URL")
        or os.getenv("DATABASE_URL_WORKGRAPH")
        or read_config_database_url()
        or ""
    )


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


def validate_tenant_id(value: str) -> str:
    tenant_id = value.strip()
    if not tenant_id:
        raise SystemExit("FAIL --default-tenant-id cannot be empty")
    if len(tenant_id) > 128:
        raise SystemExit("FAIL --default-tenant-id must be 128 characters or fewer")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$", tenant_id):
        raise SystemExit("FAIL --default-tenant-id may contain only letters, numbers, dot, underscore, colon, or dash")
    return tenant_id


def print_sample(database_url: str) -> None:
    sample_sql = f"""
with candidates as (
  select id, name, status::text as status, {TENANT_EXPR} as inferred_tenant
  from "workflow_instances"
  where "tenantId" is null
  order by "createdAt" desc
  limit 10
)
select coalesce(json_agg(candidates), '[]'::json) from candidates;
"""
    raw = psql(database_url, sample_sql)
    try:
        rows = json.loads(raw or "[]")
    except json.JSONDecodeError:
        rows = []
    if not rows:
        return
    print("Sample unresolved/inferable rows:")
    for row in rows:
        inferred = row.get("inferred_tenant") or "(none)"
        print(f"  {row.get('id')}  {row.get('status')}  inferred={inferred}  {row.get('name')}")


def count_approval_spine_candidates(database_url: str) -> tuple[int, int]:
    total = int(psql(database_url, 'select count(*) from approval_requests where "instanceId" is null'))
    inferable = int(psql(database_url, """
with candidates as (
  select ar.id, ar."formData" #>> '{targets,0,childWorkflowInstanceId}' as inferred_instance_id
  from approval_requests ar
  where ar."instanceId" is null
)
select count(*)
from candidates c
join workflow_instances wi on wi.id = c.inferred_instance_id
where wi."tenantId" is not null;
"""))
    return total, inferable


def backfill_approval_spines(database_url: str) -> int:
    return int(psql(database_url, """
with candidates as (
  select ar.id, ar."formData" #>> '{targets,0,childWorkflowInstanceId}' as inferred_instance_id
  from approval_requests ar
  where ar."instanceId" is null
), updated as (
  update approval_requests ar
  set "instanceId" = c.inferred_instance_id
  from candidates c
  join workflow_instances wi on wi.id = c.inferred_instance_id
  where ar.id = c.id
    and ar."instanceId" is null
    and wi."tenantId" is not null
  returning 1
)
select count(*) from updated;
""") or "0")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Workgraph Postgres URL. Defaults to env/config.")
    parser.add_argument("--default-tenant-id", help="Tenant id to use for rows that cannot be inferred from context.")
    parser.add_argument("--apply", action="store_true", help="Apply the backfill. Without this flag, only reports.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON summary.")
    args = parser.parse_args()

    database_url = resolve_database_url(args.database_url)
    if not database_url:
        raise SystemExit("FAIL Workgraph database URL not provided")

    default_tenant_id = validate_tenant_id(args.default_tenant_id) if args.default_tenant_id else None

    total = int(psql(database_url, 'select count(*) from "workflow_instances" where "tenantId" is null'))
    inferable = int(psql(
        database_url,
        f'select count(*) from "workflow_instances" where "tenantId" is null and {TENANT_EXPR} is not null',
    ))
    unresolved = total - inferable
    approval_null_before, approval_inferable = count_approval_spine_candidates(database_url)

    inferred_updated = 0
    default_updated = 0
    approval_spines_updated = 0
    if args.apply:
        inferred_updated = int(psql(database_url, f"""
with updated as (
  update "workflow_instances"
  set "tenantId" = {TENANT_EXPR}
  where "tenantId" is null
    and {TENANT_EXPR} is not null
  returning 1
)
select count(*) from updated;
""") or "0")
        if unresolved:
            if not default_tenant_id:
                raise SystemExit(
                    f"FAIL {unresolved} workflow_instances row(s) cannot infer tenantId; rerun with --default-tenant-id <tenant>"
                )
            default_updated = int(psql(database_url, f"""
with updated as (
  update "workflow_instances"
  set "tenantId" = {sql_literal(default_tenant_id)}
  where "tenantId" is null
  returning 1
)
select count(*) from updated;
""") or "0")
        approval_spines_updated = backfill_approval_spines(database_url)

    remaining = int(psql(database_url, 'select count(*) from "workflow_instances" where "tenantId" is null'))
    approval_null_after, _ = count_approval_spine_candidates(database_url)
    summary = {
        "mode": "apply" if args.apply else "dry-run",
        "nullTenantRowsBefore": total,
        "inferableRows": inferable,
        "unresolvedRows": unresolved,
        "inferredRowsUpdated": inferred_updated,
        "defaultRowsUpdated": default_updated,
        "nullTenantRowsAfter": remaining,
        "defaultTenantId": default_tenant_id,
        "approvalNullInstanceRowsBefore": approval_null_before,
        "approvalNullInstanceRowsInferable": approval_inferable,
        "approvalInstanceRowsUpdated": approval_spines_updated,
        "approvalNullInstanceRowsAfter": approval_null_after,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"mode: {summary['mode']}")
        print(f"null tenant rows before: {total}")
        print(f"inferable from context: {inferable}")
        print(f"unresolved without default: {unresolved}")
        if args.apply:
            print(f"inferred rows updated: {inferred_updated}")
            print(f"default rows updated: {default_updated}")
            print(f"approval instance spine rows updated: {approval_spines_updated}")
            print(f"null tenant rows after: {remaining}")
            print(f"approval rows without instance after: {approval_null_after}")
        else:
            print("dry-run only; pass --apply to mutate")
            print(f"approval rows without instance: {approval_null_before}")
            print(f"approval rows inferable from child workflow target: {approval_inferable}")
        print_sample(database_url)

    return 0 if (remaining == 0 and approval_null_after == 0) or not args.apply else 1


if __name__ == "__main__":
    raise SystemExit(main())
