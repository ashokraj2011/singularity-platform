#!/bin/sh
# Weekly capability-harness cron (Phase 4B / task #117).
#
# Wire this into your scheduler of choice. Two options that fit
# the existing platform:
#
#   1. systemd timer / launchd plist on an operator machine that
#      can reach CF + audit-gov. See cron/weekly-bench.timer for
#      a systemd template.
#
#   2. The scheduled-tasks MCP server has a `create_scheduled_task`
#      tool — call it once with a weekly cron expression
#      ("0 9 * * 1" = Mondays 9am) and the path to this script.
#
# The script does three things:
#   a) Run the full corpus through CF, publishing per-task events
#      to audit-gov.
#   b) Run the regression detector against the new history, emit
#      alerts for any model that regressed >5pp vs trailing window.
#   c) Exit with a non-zero status if regressions were found, so
#      the scheduler's failure-detection (e.g. healthchecks.io,
#      audit-gov's `cron.failed` event) fires.
#
# Required env:
#   CF_URL                       e.g. http://cf:8000
#   AUDIT_GOV_URL                e.g. http://audit-gov:8500
#   AUDIT_GOV_SERVICE_TOKEN      bearer for audit-gov ingest + search
#   LLM_GATEWAY_URL              for the LLM judge
#   JUDGE_MODEL_ALIAS            optional override; defaults to gateway default
#   CAPABILITY_HARNESS_CORPUS    path to the corpus json (default mini-3)
#   CAPABILITY_HARNESS_MODEL     model_alias to bench under (e.g. claude-haiku-4-5)

set -e

CORPUS="${CAPABILITY_HARNESS_CORPUS:-tools/capability-harness/corpora/mini-3.json}"
MODEL_ARGS=""
if [ -n "$CAPABILITY_HARNESS_MODEL" ]; then
  MODEL_ARGS="--model-alias $CAPABILITY_HARNESS_MODEL"
fi

echo "[weekly-bench] $(date -u +%FT%TZ) starting bench: corpus=$CORPUS model=${CAPABILITY_HARNESS_MODEL:-default}"

# (a) Bench run with audit-gov publishing.
python tools/capability-harness/runner.py \
  --corpus "$CORPUS" \
  --cf-url "${CF_URL:-http://localhost:8000}" \
  --judge-gateway-url "$LLM_GATEWAY_URL" \
  ${JUDGE_MODEL_ALIAS:+--judge-model-alias "$JUDGE_MODEL_ALIAS"} \
  --publish-audit-gov \
  --audit-gov-url "${AUDIT_GOV_URL:-http://localhost:8500}" \
  $MODEL_ARGS
BENCH_EXIT=$?

# (b) Regression detection against the trailing window.
# Run even if the bench itself failed — a failure might BE the regression.
python tools/capability-harness/regression.py \
  --audit-gov-url "${AUDIT_GOV_URL:-http://localhost:8500}"
REGRESSION_EXIT=$?

# (c) Composite exit. Non-zero if either the bench had any failing
# task OR the regression detector flagged something. Operators with
# `set -e` upstream will see a clean failure signal in either case.
if [ "$BENCH_EXIT" -ne 0 ] || [ "$REGRESSION_EXIT" -ne 0 ]; then
  echo "[weekly-bench] $(date -u +%FT%TZ) exiting non-zero — bench=$BENCH_EXIT regression=$REGRESSION_EXIT"
  exit 1
fi

echo "[weekly-bench] $(date -u +%FT%TZ) done — all green"
exit 0
