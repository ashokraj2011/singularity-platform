#!/usr/bin/env bash
set -euo pipefail

missing=0
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PATH; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing $name"
    missing=1
  else
    echo "ok $name"
  fi
done

if [[ -z "${DEPLOY_SSH_KEY:-}" && -z "${DEPLOY_SSH_KEY_FILE:-}" ]]; then
  echo "missing DEPLOY_SSH_KEY or DEPLOY_SSH_KEY_FILE"
  missing=1
else
  echo "ok deploy ssh key"
fi

command -v docker >/dev/null || { echo "missing docker CLI"; missing=1; }
docker compose version >/dev/null 2>&1 || { echo "missing docker compose plugin"; missing=1; }

if [[ "$missing" -ne 0 ]]; then
  echo "Deploy environment is incomplete."
  exit 1
fi

echo "Deploy environment is ready."
