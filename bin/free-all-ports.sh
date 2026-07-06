#!/usr/bin/env bash
# free-all-ports.sh — nuke every local Singularity process, even the orphans that
# `bin/bare-metal.sh down` misses (stale/missing PID file, detached children, the
# standalone Copilot bridge on :4141).
#
# It is deliberately conservative about collateral damage:
#   • NEVER touches Postgres (:5432) — the platform connects to it, it doesn't own it.
#   • NEVER touches Docker/vpnkit-owned ports (mirrors bare-metal's own guard).
#   • NEVER kills itself or its parent shell.
#
# Usage:
#   bin/free-all-ports.sh              # free every Singularity port (TERM then KILL)
#   bin/free-all-ports.sh --dry-run    # show what WOULD be killed, kill nothing
#   bin/free-all-ports.sh --deep       # also pattern-sweep orphans not holding a port
#   bin/free-all-ports.sh --deep -n    # preview the deep sweep too
set -uo pipefail

# ── The authoritative Singularity port list (kept in sync with bin/bare-metal.sh
#    BARE_METAL_*_PORT_SPECS). 5432/Postgres is intentionally absent. ──────────────
PORTS=(
  # app services
  "3001:agent-service" "3003:agent-runtime" "3004:prompt-composer"
  "5180:platform-web"  "8000:context-api"   "8080:workgraph-api"
  "8100:iam-service"   "8500:audit-governance"
  # runtime
  "8001:llm-gateway"   "7100:mcp-server"
  # optional / full-mode
  "8002:context-memory" "8010:formal-verifier" "8011:prompt-compressor"
  "8003:legacy-metrics-ledger" "8101:legacy-pseudo-iam"
  # legacy UIs / gateways
  "5174:legacy-agent-web" "5175:legacy-workgraph-web" "5176:legacy-blueprint-workbench"
  "5181:legacy-edge-gateway" "5182:legacy-portal" "8085:legacy-user-and-capability"
  # stray platform-web Next dev + the standalone Copilot CLI bridge
  "3000:stale-platform-web" "4141:copilot-cli-bridge"
)

# ── Deep-sweep signatures: unmistakable Singularity server command lines. Only used
#    with --deep, and only after the comm-based safety exclusion below. ────────────
DEEP_PATTERNS=(
  "singularity-platform/agent-and-tools"
  "singularity-platform/workgraph-studio"
  "singularity-platform/mcp-server"
  "singularity-platform/singularity-iam-service"
  "singularity-platform/context-fabric"
  "singularity-platform/audit-governance-service"
  "singularity-platform/pseudo-iam-service"
  "copilot-cli-server.js"
)
# Never kill these even if their args mention the repo (editors, pagers, VCS, this CLI).
SAFE_COMM_EXCLUDE='vim|nvim|emacs|nano|less|more|tail|git|grep|rg|fzf|ripgrep|man|ssh|Code|Cursor|Electron|claude|node-gyp'

# ── colours (fall back to plain if not a tty) ──────────────────────────────────
if [ -t 1 ]; then R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; B=$'\033[1m'; X=$'\033[0m'; else R=; G=; Y=; D=; B=; X=; fi
info() { printf '%s\n' "${B}$*${X}"; }
dim()  { printf '%s\n' "${D}$*${X}"; }
warn() { printf '%s\n' "${Y}! $*${X}"; }
ok()   { printf '%s\n' "${G}✓ $*${X}"; }

DRY=0; DEEP=0
for a in "$@"; do case "$a" in
  -n|--dry-run) DRY=1 ;;
  --deep)       DEEP=1 ;;
  -h|--help)    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown arg: $a (try --help)" >&2; exit 2 ;;
esac; done

command -v lsof >/dev/null 2>&1 || { echo "lsof not found — cannot free ports" >&2; exit 1; }

SELF=$$
KILLED=0; SKIPPED=0; FOUND=0

# kill_one <pid> <why> — TERM, wait up to 2s, then KILL; honours safety rails + --dry-run.
kill_one() {
  local pid="$1" why="$2" comm
  [ -n "$pid" ] || return 0
  [ "$pid" = "$SELF" ] && return 0
  [ "$pid" = "$PPID" ] && return 0
  comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
  [ -n "$comm" ] || return 0                                  # already gone
  case "$comm" in
    *docker*|*Docker*|*vpnkit*|*com.docker*)
      warn "  skip pid $pid (${comm##*/}) — Docker-owned"; SKIPPED=$((SKIPPED+1)); return 0 ;;
  esac
  if [ "$DRY" = 1 ]; then
    printf '  %swould kill%s pid %-6s %-22s — %s\n' "$Y" "$X" "$pid" "(${comm##*/})" "$why"
    FOUND=$((FOUND+1)); return 0
  fi
  # kill the whole process tree, children first
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_one "$child" "child of $why"; done
  kill "$pid" 2>/dev/null || true
  local n=0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.2; n=$((n+1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    printf '  %sforce-killed%s pid %-6s %-22s — %s\n' "$R" "$X" "$pid" "(${comm##*/})" "$why"
  else
    printf '  %skilled%s      pid %-6s %-22s — %s\n' "$G" "$X" "$pid" "(${comm##*/})" "$why"
  fi
  KILLED=$((KILLED+1))
}

info "Singularity free-all — $([ "$DRY" = 1 ] && echo 'DRY RUN (nothing will be killed)' || echo 'killing') $([ "$DEEP" = 1 ] && echo '+ deep orphan sweep')"
dim  "(Postgres :5432 and Docker-owned ports are left alone)"
echo

# ── Pass 1: port-based (precise — only things actually holding a Singularity port) ──
info "Ports:"
for spec in "${PORTS[@]}"; do
  port="${spec%%:*}"; label="${spec#*:}"
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] || continue
  for pid in $pids; do kill_one "$pid" "$label on :$port"; done
done
[ "$KILLED" = 0 ] && [ "$FOUND" = 0 ] && dim "  (no listeners on any Singularity port)"

# ── Pass 2: --deep pattern sweep for orphans that no longer hold a listener ─────────
if [ "$DEEP" = 1 ]; then
  echo; info "Deep sweep (orphans by command signature):"
  local_found=0
  for pat in "${DEEP_PATTERNS[@]}"; do
    for pid in $(pgrep -f "$pat" 2>/dev/null || true); do
      [ "$pid" = "$SELF" ] && continue
      comm=$(ps -p "$pid" -o comm= 2>/dev/null || true)
      [ -n "$comm" ] || continue
      # skip editors/pagers/VCS/this CLI even if their args mention the repo path
      if printf '%s' "${comm##*/}" | grep -qiE "^(${SAFE_COMM_EXCLUDE})$"; then continue; fi
      kill_one "$pid" "orphan matching '$pat'"; local_found=1
    done
  done
  [ "$local_found" = 0 ] && dim "  (no matching orphans)"
fi

# ── Report ─────────────────────────────────────────────────────────────────────
echo
if [ "$DRY" = 1 ]; then
  ok "dry run complete — $FOUND process(es) would be killed, $SKIPPED skipped. Re-run without --dry-run to do it."
  exit 0
fi

# verify: anything still listening?
still=""
for spec in "${PORTS[@]}"; do
  port="${spec%%:*}"
  lsof -ti tcp:"$port" -sTCP:LISTEN >/dev/null 2>&1 && still="$still ${port}(${spec#*:})"
done
if [ -n "$still" ]; then
  warn "still listening after sweep:$still"
  warn "these may be Docker-owned or need sudo — inspect with:  lsof -i tcp:<port> -sTCP:LISTEN"
  exit 1
fi
ok "all clear — killed $KILLED, skipped $SKIPPED. No Singularity ports remain in use."
