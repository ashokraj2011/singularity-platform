#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROMPT_COMPOSER_DATABASE_URL:-${DATABASE_URL:-}}" ]]; then
  echo "Set PROMPT_COMPOSER_DATABASE_URL or DATABASE_URL before running this check."
  exit 1
fi

DB_URL="${PROMPT_COMPOSER_DATABASE_URL:-${DATABASE_URL:-}}"

command -v psql >/dev/null || { echo "missing psql"; exit 1; }

psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
       THEN 'OK vector extension'
       ELSE 'FAIL vector extension missing'
  END AS check;

SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'PromptAssembly' AND column_name = 'evidenceRefs'
  ) THEN 'OK PromptAssembly.evidenceRefs'
    ELSE 'FAIL PromptAssembly.evidenceRefs missing'
  END AS check;

SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'CapabilityCompiledContext'
  ) THEN 'OK CapabilityCompiledContext'
    ELSE 'FAIL CapabilityCompiledContext missing'
  END AS check;

SELECT id, pg_column_size("evidenceRefs") AS evidence_refs_bytes
FROM "PromptAssembly"
WHERE "evidenceRefs" IS NOT NULL
ORDER BY "createdAt" DESC
LIMIT 5;
SQL
