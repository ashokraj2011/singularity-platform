#!/usr/bin/env bash
# Local edge-gateway for bare-metal dev.
#
# Serves the BLUE Blueprint Workbench cockpit (vite dev, :5176, base /workbench/)
# and the unified platform-web (:5180) under ONE origin (:8085), via an
# nginx:alpine container (edge-gateway/local.conf). Single origin means the
# singularity-portal.auth token is shared, so the CALL_WORKFLOW "Open Workbench"
# launch URL opens the real cockpit (not the native console) with auth intact.
#
# Requires: Docker running, and the bare-metal stack already up (platform-web
# :5180 + workgraph-api). The host does NOT need nginx installed.
#
#   bin/local-gateway.sh up        # start cockpit + gateway
#   bin/local-gateway.sh down      # stop both
#   bin/local-gateway.sh status    # health check
#
# Then open http://localhost:8085, log in THERE, and view runs at :8085
# (change :5180 -> :8085 in the URL) so "Open Workbench" opens the blue cockpit.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COCKPIT="$REPO/workgraph-studio/apps/blueprint-workbench"
CONF="$REPO/edge-gateway/local.conf"
CONTAINER="${GW_CONTAINER:-sing-gateway}"
GW_PORT="${GW_PORT:-8085}"
COCKPIT_PORT="${COCKPIT_PORT:-5176}"
WEB_PORT="${WEB_PORT:-5180}"
LOG="${TMPDIR:-/tmp}/sing-cockpit.log"

cockpit_up()  { curl -sf -o /dev/null "http://localhost:$COCKPIT_PORT/workbench/" 2>/dev/null; }

status() {
  printf "  cockpit  :%s/workbench/  -> %s\n" "$COCKPIT_PORT" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$COCKPIT_PORT/workbench/" 2>/dev/null)"
  printf "  gateway  :%s/            -> %s\n" "$GW_PORT" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$GW_PORT/" 2>/dev/null)"
  printf "  gateway  :%s/workbench/   -> %s %s\n" "$GW_PORT" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$GW_PORT/workbench/" 2>/dev/null)" \
    "$(curl -s "http://localhost:$GW_PORT/workbench/" 2>/dev/null | grep -o '<title>[^<]*</title>')"
}

up() {
  command -v docker >/dev/null || { echo "docker not found — required for the gateway container" >&2; exit 1; }
  [ -x "$COCKPIT/node_modules/.bin/vite" ] || { echo "cockpit deps missing — run: (cd $COCKPIT && npm install)" >&2; exit 1; }

  # 1) Blue cockpit (vite dev, base /workbench/). Detached so it outlives this shell.
  if cockpit_up; then
    echo "cockpit already running on :$COCKPIT_PORT"
  else
    echo "starting blue cockpit on :$COCKPIT_PORT ..."
    ( cd "$COCKPIT" && BASE_PATH=/workbench/ nohup node_modules/.bin/vite --host 0.0.0.0 \
        > "$LOG" 2>&1 < /dev/null & )
    for _ in $(seq 1 25); do sleep 1; cockpit_up && break; done
    cockpit_up || { echo "cockpit failed to start — see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
  fi

  # 2) nginx gateway container -> host platform-web :5180 + cockpit :5176.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p "$GW_PORT:8085" \
    --add-host host.docker.internal:host-gateway \
    -v "$CONF:/etc/nginx/nginx.conf:ro" \
    nginx:alpine >/dev/null
  sleep 2

  echo "── gateway up ──"
  status
  echo
  echo "Open http://localhost:$GW_PORT and log in THERE."
  echo "View runs at :$GW_PORT (change :$WEB_PORT -> :$GW_PORT) so 'Open Workbench' opens the BLUE cockpit."
}

down() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "gateway container stopped" || echo "gateway not running"
  pid="$(lsof -ti "tcp:$COCKPIT_PORT" 2>/dev/null || true)"
  if [ -n "$pid" ]; then kill $pid 2>/dev/null && echo "cockpit stopped (pid $pid)"; else echo "cockpit not running"; fi
}

case "${1:-up}" in
  up)            up ;;
  down)          down ;;
  status|st)     status ;;
  *) echo "usage: $(basename "$0") {up|down|status}" >&2; exit 2 ;;
esac
