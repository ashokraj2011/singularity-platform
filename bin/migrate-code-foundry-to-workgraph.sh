#!/usr/bin/env bash
set -euo pipefail

# One-time compatibility importer for the retired standalone Foundry API.
# It copies existing rows from at-postgres/singularity_codegen into
# wg-postgres/workgraph, preserving IDs and skipping duplicates.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_CONTAINER="${CODE_FOUNDRY_SOURCE_CONTAINER:-singularity-at-postgres}"
SOURCE_DB="${CODE_FOUNDRY_SOURCE_DB:-singularity_codegen}"
SOURCE_USER="${CODE_FOUNDRY_SOURCE_USER:-postgres}"
TARGET_CONTAINER="${WORKGRAPH_TARGET_CONTAINER:-singularity-wg-postgres}"
TARGET_DB="${WORKGRAPH_TARGET_DB:-workgraph}"
TARGET_USER="${WORKGRAPH_TARGET_USER:-workgraph}"
TENANT_ID="${CODE_FOUNDRY_IMPORT_TENANT_ID:-}"
LEGACY_WORKSPACE="${CODE_FOUNDRY_LEGACY_WORKSPACE:-$ROOT/singularity-code-foundry/.workspace}"

usage() {
  cat <<USAGE
Usage: CODE_FOUNDRY_IMPORT_TENANT_ID=<tenant-id> $0

Environment:
  CODE_FOUNDRY_SOURCE_CONTAINER  default: singularity-at-postgres
  CODE_FOUNDRY_SOURCE_DB         default: singularity_codegen
  CODE_FOUNDRY_SOURCE_USER       default: postgres
  WORKGRAPH_TARGET_CONTAINER     default: singularity-wg-postgres
  WORKGRAPH_TARGET_DB            default: workgraph
  WORKGRAPH_TARGET_USER          default: workgraph
  CODE_FOUNDRY_IMPORT_TENANT_ID  optional tenantId assigned to imported specs,
                                 runs, repo models, and change plans
  CODE_FOUNDRY_LEGACY_WORKSPACE  host path for old /workspace files; when
                                 present, artifact file content is copied into
                                 Workgraph's codegen_artifacts.content column
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need_container() {
  local name="$1"
  if ! docker inspect "$name" >/dev/null 2>&1; then
    echo "FAIL container '$name' not found. Start the stack first." >&2
    exit 1
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]]; then
    echo "FAIL container '$name' is not running. Start the stack first." >&2
    exit 1
  fi
}

source_psql() {
  docker exec "$SOURCE_CONTAINER" psql -U "$SOURCE_USER" -d "$SOURCE_DB" -v ON_ERROR_STOP=1 "$@"
}

target_psql() {
  docker exec -i "$TARGET_CONTAINER" psql -U "$TARGET_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 "$@"
}

table_exists() {
  local container="$1"
  local user="$2"
  local db="$3"
  local table="$4"
  docker exec "$container" psql -U "$user" -d "$db" -At -v ON_ERROR_STOP=1 \
    -c "select to_regclass('public.${table}') is not null" | tr -d '[:space:]'
}

copy_table() {
  local table="$1"
  local columns="$2"
  local tenant_scoped="${3:-0}"
  local csv="$TMPDIR/${table}.csv"

  if [[ "$(table_exists "$SOURCE_CONTAINER" "$SOURCE_USER" "$SOURCE_DB" "$table")" != "t" ]]; then
    echo "skip $table: source table missing"
    return
  fi
  if [[ "$(table_exists "$TARGET_CONTAINER" "$TARGET_USER" "$TARGET_DB" "$table")" != "t" ]]; then
    echo "FAIL $table: target table missing. Run Workgraph migrations first." >&2
    exit 1
  fi

  source_psql -q -c "COPY (SELECT ${columns} FROM public.${table}) TO STDOUT WITH CSV HEADER" > "$csv"

  local insert_columns="$columns"
  local select_columns="$columns"
  if [[ "$tenant_scoped" == "1" ]]; then
    insert_columns="${columns}, \"tenantId\""
    select_columns="${columns}, NULLIF(:'tenant_id', '')"
  fi

  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE _cf_import (LIKE public.${table});"
    echo "COPY _cf_import (${columns}) FROM STDIN WITH CSV HEADER;"
    cat "$csv"
    echo "\\."
    echo "INSERT INTO public.${table} (${insert_columns}) SELECT ${select_columns} FROM _cf_import ON CONFLICT DO NOTHING;"
    echo "COMMIT;"
  } | target_psql -q -v tenant_id="$TENANT_ID"

  local source_count
  local target_count
  source_count="$(docker exec "$SOURCE_CONTAINER" psql -U "$SOURCE_USER" -d "$SOURCE_DB" -At -c "select count(*) from public.${table}" | tr -d '[:space:]')"
  target_count="$(docker exec "$TARGET_CONTAINER" psql -U "$TARGET_USER" -d "$TARGET_DB" -At -c "select count(*) from public.${table}" | tr -d '[:space:]')"
  echo "ok   $table: copied $source_count row(s), target now has $target_count row(s)"
}

hydrate_artifact_content() {
  if [[ ! -d "$LEGACY_WORKSPACE" ]]; then
    echo "skip artifact content hydration: legacy workspace not found at $LEGACY_WORKSPACE"
    return
  fi

  local manifest="$TMPDIR/artifacts-to-hydrate.csv"
  local content_csv="$TMPDIR/artifact-content.csv"
  local count_file="$TMPDIR/artifact-content.count"
  docker exec "$TARGET_CONTAINER" psql -U "$TARGET_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -q \
    -c "COPY (
      SELECT a.id, r.\"outputPath\", a.path
      FROM public.codegen_artifacts a
      JOIN public.codegen_runs r ON r.id = a.\"runId\"
      WHERE a.content IS NULL
        AND r.\"outputPath\" IS NOT NULL
        AND r.\"outputPath\" LIKE '/workspace/%'
      ORDER BY a.\"createdAt\" ASC
    ) TO STDOUT WITH CSV HEADER" > "$manifest"

  CODE_FOUNDRY_IMPORT_MANIFEST="$manifest" \
  CODE_FOUNDRY_IMPORT_CONTENT="$content_csv" \
  CODE_FOUNDRY_IMPORT_COUNT="$count_file" \
  CODE_FOUNDRY_LEGACY_WORKSPACE="$LEGACY_WORKSPACE" \
  python3 - <<'PY'
import csv
import os
from pathlib import Path

manifest = Path(os.environ["CODE_FOUNDRY_IMPORT_MANIFEST"])
out = Path(os.environ["CODE_FOUNDRY_IMPORT_CONTENT"])
count_file = Path(os.environ["CODE_FOUNDRY_IMPORT_COUNT"])
workspace = Path(os.environ["CODE_FOUNDRY_LEGACY_WORKSPACE"]).resolve()
rows = 0

with manifest.open(newline="", encoding="utf-8") as source, out.open("w", newline="", encoding="utf-8") as dest:
    reader = csv.DictReader(source)
    writer = csv.DictWriter(dest, fieldnames=["id", "content", "sizeBytes"])
    writer.writeheader()
    for row in reader:
        output_path = row.get("outputPath") or ""
        rel_path = row.get("path") or ""
        if not output_path.startswith("/workspace/") or rel_path.startswith("/"):
            continue
        candidate = (workspace / output_path.removeprefix("/workspace/") / rel_path).resolve()
        try:
            candidate.relative_to(workspace)
        except ValueError:
            continue
        if not candidate.is_file():
            continue
        data = candidate.read_bytes()
        writer.writerow({
            "id": row["id"],
            "content": data.decode("utf-8", "replace"),
            "sizeBytes": len(data),
        })
        rows += 1

count_file.write_text(str(rows), encoding="utf-8")
PY

  local hydrated
  hydrated="$(cat "$count_file")"
  if [[ "$hydrated" == "0" ]]; then
    echo "ok   artifact content hydration: no legacy files found under $LEGACY_WORKSPACE"
    return
  fi

  {
    echo "CREATE TEMP TABLE _cf_artifact_content (id text, content text, \"sizeBytes\" integer);"
    echo "COPY _cf_artifact_content (id, content, \"sizeBytes\") FROM STDIN WITH CSV HEADER;"
    cat "$content_csv"
    echo "\\."
    echo "UPDATE public.codegen_artifacts a SET content = c.content, \"sizeBytes\" = c.\"sizeBytes\" FROM _cf_artifact_content c WHERE a.id = c.id;"
  } | target_psql -q
  echo "ok   artifact content hydration: stored $hydrated file(s) from $LEGACY_WORKSPACE"
}

need_container "$SOURCE_CONTAINER"
need_container "$TARGET_CONTAINER"

if ! docker exec "$SOURCE_CONTAINER" psql -U "$SOURCE_USER" -d postgres -At \
  -c "select 1 from pg_database where datname='${SOURCE_DB}'" | grep -q '^1$'; then
  echo "No legacy Foundry database '$SOURCE_DB' found in $SOURCE_CONTAINER; nothing to import."
  exit 0
fi

TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/code-foundry-import.XXXXXX")"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$ROOT"

echo "Importing legacy Foundry data from $SOURCE_CONTAINER/$SOURCE_DB to $TARGET_CONTAINER/$TARGET_DB"
if [[ -n "$TENANT_ID" ]]; then
  echo "Assigning imported runtime rows to tenantId=$TENANT_ID"
fi

copy_table codegen_repo_models '"id", "repoPath", "language", "framework", "modelJson", "modelHash", "scannedById", "scannedAt"' 1
copy_table codegen_change_plans '"id", "repoModelId", "enhancementSpecJson", "enhancementSpecHash", "planJson", "planHash", "status", "createdAt", "appliedAt"' 1
copy_table codegen_specs '"id", "specName", "version", "kind", "state", "yaml", "canonicalJson", "specHash", "irJson", "irHash", "workItemId", "createdById", "createdAt", "updatedAt"' 1
copy_table codegen_spec_lifecycle_events '"id", "specId", "fromState", "toState", "actorId", "reason", "payload", "occurredAt"'
copy_table codegen_runs '"id", "specId", "irHash", "templateVersion", "generatorVersion", "status", "mode", "brownfieldPlanId", "outputPath", "startedAt", "completedAt"' 1
copy_table codegen_artifacts '"id", "runId", "path", "contentHash", "fileType", "generatedBy", "protected", "createdAt"'
copy_table codegen_gaps '"id", "runId", "gapType", "severity", "filePath", "className", "methodName", "regionId", "description", "recommendedResolution", "llmEligible", "resolved", "createdAt", "resolvedAt"'
copy_table codegen_llm_patch_tasks '"id", "runId", "gapId", "taskType", "status", "targetFile", "targetClass", "targetMethod", "regionId", "allowedChanges", "forbiddenChanges", "promptHash", "responseHash", "cfCallId", "bundleHash", "metadata", "createdAt", "dispatchedAt", "completedAt"'
copy_table codegen_verifications '"id", "runId", "status", "result", "createdAt"'
copy_table codegen_receipts '"id", "runId", "receiptJson", "receiptHash", "createdAt"'
hydrate_artifact_content

target_psql -q <<'SQL'
INSERT INTO public.receipts ("id", "receiptType", "entityType", "entityId", "content", "generatedAt")
SELECT gen_random_uuid()::text, 'code_generation', 'codegen_run', cr."runId", cr."receiptJson", cr."createdAt"
FROM public.codegen_receipts cr
WHERE NOT EXISTS (
  SELECT 1
  FROM public.receipts r
  WHERE r."receiptType" = 'code_generation'
    AND r."entityType" = 'codegen_run'
    AND r."entityId" = cr."runId"
);
SQL

echo "Legacy Foundry import complete."
