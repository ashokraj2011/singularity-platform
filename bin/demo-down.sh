#!/usr/bin/env bash
# Demo teardown — stops all services launched by bin/demo-up.sh.
# Leaves Homebrew Postgres@14 running (the bare-metal stack needs it next time).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }
warn() { echo -e "${C_YELLOW}⚠${C_END} $*"; }

info "stopping services on demo ports…"
for port in 3001 3002 3003 3004 5180 7100 8000 8080 8100 8101 8500; do
  pids=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    killed=""
    for pid in $pids; do
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
      case "$cmd" in
        *docker*|*Docker*|*vpnkit*)
          warn "port $port is Docker-owned (pid $pid); leaving it alone"
          continue
          ;;
      esac
      kill -9 "$pid" 2>/dev/null && killed="$killed $pid"
    done
    [ -n "$killed" ] && echo "  port $port → killed$killed"
  fi
done

info "killing any leftover ts-node-dev / npm-run-dev / uvicorn workers…"
pgrep -af "ts-node-dev\|npm run dev\|uvicorn.*app.main\|vite.*--port" 2>/dev/null | \
  grep -v claude | grep -v Cursor | awk '{print $1}' | \
  xargs -I{} kill -9 {} 2>/dev/null || true
sleep 1

info "final port check…"
STUCK=0
for port in 3001 3002 3003 3004 5180 7100 8000 8080 8100 8101 8500; do
  pids=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*) continue ;;
    esac
    warn "port $port still has pid $pid"
    STUCK=1
  done
done
[ $STUCK -eq 0 ] && ok "all demo ports clear"

# Try to remove stale bare-metal PID files.
rm -f "$ROOT/.pids" "$ROOT/.pids.runtime" 2>/dev/null || true

echo
ok "Demo stack stopped."
echo "  Homebrew Postgres@14 left running (needed by ./bin/demo-up.sh next time)"
echo "  To stop Postgres too:  brew services stop postgresql@14"
