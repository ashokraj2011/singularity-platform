#!/usr/bin/env bash
set -euo pipefail

STRICT_DATA=0

usage() {
  cat <<'EOF'
Usage:
  PROMPT_COMPOSER_DATABASE_URL=postgresql://.../singularity_composer \
  PROMPT_RUNTIME_DATABASE_URL=postgresql://.../singularity \
    ./bin/check-m25-knowledge.sh [--strict-data]

Environment:
  PROMPT_COMPOSER_DATABASE_URL  Composer-owned DB with PromptAssembly and CapabilityCompiledContext.
  PROMPT_RUNTIME_DATABASE_URL   Runtime-read DB with CapabilityKnowledgeArtifact and DistilledMemory.

Compatibility aliases:
  DATABASE_URL_COMPOSER, DATABASE_URL_RUNTIME_READ, AGENT_RUNTIME_DATABASE_URL, DATABASE_URL

Options:
  --strict-data   Also require at least one active retrieval source and one PromptAssembly
                  with evidenceRefs. Use after demo seed/backfill, not on a fresh empty DB.
  -h, --help      Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict-data) STRICT_DATA=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

COMPOSER_DB_URL="${PROMPT_COMPOSER_DATABASE_URL:-${DATABASE_URL_COMPOSER:-${DATABASE_URL:-}}}"
RUNTIME_DB_URL="${PROMPT_RUNTIME_DATABASE_URL:-${DATABASE_URL_RUNTIME_READ:-${AGENT_RUNTIME_DATABASE_URL:-${DATABASE_URL:-}}}}"

if [[ -z "$COMPOSER_DB_URL" || -z "$RUNTIME_DB_URL" ]]; then
  echo "Set PROMPT_COMPOSER_DATABASE_URL and PROMPT_RUNTIME_DATABASE_URL before running this check."
  echo "Use --help for examples."
  exit 1
fi

command -v psql >/dev/null || { echo "missing psql"; exit 1; }

FAILURES=0

ok()   { printf 'OK   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
info() { printf 'INFO %s\n' "$*"; }

sql_value() {
  local db_url="$1"
  local sql="$2"
  psql "$db_url" -v ON_ERROR_STOP=1 -qAt -c "$sql"
}

expect_scalar() {
  local label="$1"
  local db_url="$2"
  local sql="$3"
  local expected="$4"
  local value
  if ! value="$(sql_value "$db_url" "$sql" 2>&1)"; then
    fail "$label ($value)"
    return
  fi
  if [[ "$value" == "$expected" ]]; then
    ok "$label"
  else
    fail "$label (expected $expected, got ${value:-<empty>})"
  fi
}

expect_zero() {
  local label="$1"
  local db_url="$2"
  local sql="$3"
  expect_scalar "$label" "$db_url" "$sql" "0"
}

expect_positive() {
  local label="$1"
  local db_url="$2"
  local sql="$3"
  local value
  if ! value="$(sql_value "$db_url" "$sql" 2>&1)"; then
    fail "$label ($value)"
    return
  fi
  if [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]]; then
    ok "$label"
  else
    fail "$label (expected > 0, got ${value:-<empty>})"
  fi
}

column_exists_sql() {
  local table="$1"
  local column="$2"
  printf "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '%s' AND column_name = '%s';" "$table" "$column"
}

table_exists_sql() {
  local table="$1"
  printf "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '%s';" "$table"
}

index_exists_sql() {
  local index="$1"
  printf "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = '%s';" "$index"
}

tsvector_column_sql() {
  local table="$1"
  printf "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '%s' AND column_name = 'content_tsv' AND udt_name = 'tsvector';" "$table"
}

gin_content_index_sql() {
  local table="$1"
  printf "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = '%s' AND indexdef ILIKE '%%USING gin%%content_tsv%%';" "$table"
}

printf 'M25 knowledge/citation readiness\n'
printf 'Composer DB: %s\n' "$COMPOSER_DB_URL"
printf 'Runtime DB:  %s\n' "$RUNTIME_DB_URL"
printf '\n'

info "checking composer-owned citation/capsule schema"
expect_scalar "composer database reachable" "$COMPOSER_DB_URL" "SELECT 1;" "1"
expect_scalar "composer pgvector extension installed" "$COMPOSER_DB_URL" "SELECT count(*) FROM pg_extension WHERE extname = 'vector';" "1"
expect_scalar "PromptAssembly table exists" "$COMPOSER_DB_URL" "$(table_exists_sql "PromptAssembly")" "1"
expect_scalar "PromptAssembly.evidenceRefs exists" "$COMPOSER_DB_URL" "$(column_exists_sql "PromptAssembly" "evidenceRefs")" "1"
expect_scalar "PromptAssembly.compiledContextId exists" "$COMPOSER_DB_URL" "$(column_exists_sql "PromptAssembly" "compiledContextId")" "1"
expect_scalar "PromptAssembly.traceId exists" "$COMPOSER_DB_URL" "$(column_exists_sql "PromptAssembly" "traceId")" "1"
expect_scalar "CapabilityCompiledContext table exists" "$COMPOSER_DB_URL" "$(table_exists_sql "CapabilityCompiledContext")" "1"
for column in capabilityId agentTemplateId taskSignature intent compiledContent compileMode citations estimatedTokens hitCount status expiresAt; do
  expect_scalar "CapabilityCompiledContext.$column exists" "$COMPOSER_DB_URL" "$(column_exists_sql "CapabilityCompiledContext" "$column")" "1"
done
expect_scalar "CapabilityCompiledContext.taskSignature unique index exists" "$COMPOSER_DB_URL" \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CapabilityCompiledContext' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%taskSignature%';" \
  "1"
expect_zero "PromptAssembly.evidenceRefs rows are JSON arrays" "$COMPOSER_DB_URL" \
  "SELECT count(*) FROM \"PromptAssembly\" WHERE \"evidenceRefs\" IS NOT NULL AND jsonb_typeof(\"evidenceRefs\"::jsonb) <> 'array';"
expect_zero "PromptAssembly.evidenceRefs rows stay under 512 KiB" "$COMPOSER_DB_URL" \
  "SELECT count(*) FROM \"PromptAssembly\" WHERE \"evidenceRefs\" IS NOT NULL AND pg_column_size(\"evidenceRefs\") > 524288;"
expect_zero "READY compiled contexts have non-empty content and citation arrays" "$COMPOSER_DB_URL" \
  "SELECT count(*) FROM \"CapabilityCompiledContext\" WHERE status = 'READY' AND (length(trim(\"compiledContent\")) = 0 OR jsonb_typeof(citations::jsonb) <> 'array');"

printf '\n'
info "checking runtime-read retrieval schema"
expect_scalar "runtime database reachable" "$RUNTIME_DB_URL" "SELECT 1;" "1"
expect_scalar "runtime pgvector extension installed" "$RUNTIME_DB_URL" "SELECT count(*) FROM pg_extension WHERE extname = 'vector';" "1"
expect_scalar "CapabilityKnowledgeArtifact table exists" "$RUNTIME_DB_URL" "$(table_exists_sql "CapabilityKnowledgeArtifact")" "1"
expect_scalar "CapabilityKnowledgeArtifact.embedding exists" "$RUNTIME_DB_URL" "$(column_exists_sql "CapabilityKnowledgeArtifact" "embedding")" "1"
expect_scalar "CapabilityKnowledgeArtifact.content_tsv exists as tsvector" "$RUNTIME_DB_URL" "$(tsvector_column_sql "CapabilityKnowledgeArtifact")" "1"
expect_scalar "CapabilityKnowledgeArtifact embedding HNSW index exists" "$RUNTIME_DB_URL" "$(index_exists_sql "idx_knowledgeartifact_embedding")" "1"
expect_scalar "CapabilityKnowledgeArtifact content_tsv GIN index exists" "$RUNTIME_DB_URL" "$(gin_content_index_sql "CapabilityKnowledgeArtifact")" "1"
expect_zero "CapabilityKnowledgeArtifact active rows have generated content_tsv" "$RUNTIME_DB_URL" \
  "SELECT count(*) FROM \"CapabilityKnowledgeArtifact\" WHERE status = 'ACTIVE' AND length(trim(content)) > 0 AND content_tsv IS NULL;"

expect_scalar "DistilledMemory table exists" "$RUNTIME_DB_URL" "$(table_exists_sql "DistilledMemory")" "1"
expect_scalar "DistilledMemory.embedding exists" "$RUNTIME_DB_URL" "$(column_exists_sql "DistilledMemory" "embedding")" "1"
expect_scalar "DistilledMemory.content_tsv exists as tsvector" "$RUNTIME_DB_URL" "$(tsvector_column_sql "DistilledMemory")" "1"
expect_scalar "DistilledMemory embedding HNSW index exists" "$RUNTIME_DB_URL" "$(index_exists_sql "idx_distilledmemory_embedding")" "1"
expect_scalar "DistilledMemory content_tsv GIN index exists" "$RUNTIME_DB_URL" "$(gin_content_index_sql "DistilledMemory")" "1"
expect_zero "DistilledMemory active rows have generated content_tsv" "$RUNTIME_DB_URL" \
  "SELECT count(*) FROM \"DistilledMemory\" WHERE status = 'ACTIVE' AND length(trim(content)) > 0 AND content_tsv IS NULL;"

printf '\n'
info "recent PromptAssembly evidence sizes"
if ! psql "$COMPOSER_DB_URL" -v ON_ERROR_STOP=1 -q -c \
  'SELECT id, pg_column_size("evidenceRefs") AS evidence_refs_bytes FROM "PromptAssembly" WHERE "evidenceRefs" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 5;'; then
  fail "could not list recent PromptAssembly evidence sizes"
fi

if [[ "$STRICT_DATA" -eq 1 ]]; then
  printf '\n'
  info "checking strict seeded/backfilled data readiness"
  expect_positive "at least one PromptAssembly has evidenceRefs" "$COMPOSER_DB_URL" \
    "SELECT count(*) FROM \"PromptAssembly\" WHERE \"evidenceRefs\" IS NOT NULL AND jsonb_array_length(\"evidenceRefs\"::jsonb) > 0;"
  expect_positive "at least one active retrieval source exists" "$RUNTIME_DB_URL" \
    "SELECT (SELECT count(*) FROM \"CapabilityKnowledgeArtifact\" WHERE status = 'ACTIVE') + (SELECT count(*) FROM \"DistilledMemory\" WHERE status = 'ACTIVE');"
  expect_positive "at least one active retrieval source has an embedding" "$RUNTIME_DB_URL" \
    "SELECT (SELECT count(*) FROM \"CapabilityKnowledgeArtifact\" WHERE status = 'ACTIVE' AND embedding IS NOT NULL) + (SELECT count(*) FROM \"DistilledMemory\" WHERE status = 'ACTIVE' AND embedding IS NOT NULL);"
fi

printf '\n'
if [[ "$FAILURES" -gt 0 ]]; then
  echo "M25 readiness failed with $FAILURES issue(s)."
  echo "Repair hints:"
  echo "  - Docker/split: docker compose restart agent-runtime, or run bin/apply-schemas.sh."
  echo "  - Bare metal: rerun bin/bare-metal.sh up so prisma/post-push.sql is applied."
  echo "  - Fresh DBs: seed first, then rerun with --strict-data if validating demo readiness."
  exit 1
fi

echo "M25 readiness passed."
