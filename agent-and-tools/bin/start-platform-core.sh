#!/bin/sh
set -eu

log() {
  printf '[platform-core] %s\n' "$*"
}

fatal() {
  printf '[platform-core] fatal: %s\n' "$*" >&2
  exit 1
}

DATABASE_URL_AGENT_TOOLS="${DATABASE_URL_AGENT_TOOLS:-${DATABASE_URL:-}}"
DATABASE_URL_COMPOSER="${DATABASE_URL_COMPOSER:-postgresql://postgres:singularity@at-postgres:5432/singularity_composer}"
DATABASE_URL_RUNTIME_READ="${DATABASE_URL_RUNTIME_READ:-$DATABASE_URL_AGENT_TOOLS}"

[ -n "$DATABASE_URL_AGENT_TOOLS" ] || fatal "DATABASE_URL_AGENT_TOOLS or DATABASE_URL must be set"

export DATABASE_URL_AGENT_TOOLS DATABASE_URL_COMPOSER DATABASE_URL_RUNTIME_READ

wait_for_pg() {
  name="$1"
  url="$2"
  log "waiting for $name postgres"
  for _ in $(seq 1 60); do
    if pg_isready -d "$url" >/dev/null 2>&1; then
      log "$name postgres is ready"
      return 0
    fi
    sleep 1
  done
  fatal "$name postgres was not ready after 60s"
}

wait_for_pg "agent-tools" "$DATABASE_URL_AGENT_TOOLS"
wait_for_pg "prompt-composer" "$DATABASE_URL_COMPOSER"

pids=""

start_service() {
  name="$1"
  shift
  log "starting $name"
  "$@" &
  pids="$pids $!"
}

stop_children() {
  log "stopping child services"
  kill $pids 2>/dev/null || true
  wait 2>/dev/null || true
}

trap stop_children INT TERM

start_service "agent-service" sh -c 'cd /app/apps/agent-service && PORT=3001 DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" PUBLIC_BASE_URL=http://agent-service:3001 node dist/index.js'
start_service "tool-service" sh -c 'cd /app/apps/tool-service && PORT=3002 DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" PUBLIC_BASE_URL=http://tool-service:3002 node dist/index.js'
start_service "agent-runtime" sh -c 'cd /app/apps/agent-runtime && PORT=3003 DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" PUBLIC_BASE_URL=http://agent-runtime:3003 ./bin/startup.sh node dist/server.js'
start_service "prompt-composer" sh -c 'cd /app/apps/prompt-composer && PORT=3004 DATABASE_URL="$DATABASE_URL_COMPOSER" DATABASE_URL_RUNTIME_READ="$DATABASE_URL_RUNTIME_READ" PUBLIC_BASE_URL=http://prompt-composer:3004 ./bin/startup.sh node dist/server.js'

while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "child process $pid exited; stopping platform-core"
      stop_children
      exit 1
    fi
  done
  sleep 2
done
