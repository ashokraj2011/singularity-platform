#!/usr/bin/env bash
# Guard against nginx pinning stale Docker service IPs.
#
# In Docker, service names can move to a new container IP after a restart.
# nginx resolves static proxy_pass hostnames only when it loads config, so
# `proxy_pass http://workgraph-api:8080/...` can become a recurring 502 after
# the backend container is recreated. Use Docker DNS with a variable upstream:
#
#   resolver 127.0.0.11 ipv6=off valid=10s;
#   set $workgraph_api http://workgraph-api:8080;
#   proxy_pass $workgraph_api;

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

while IFS= read -r file; do
  grep -q "proxy_pass" "$file" || continue

  static_hits="$(
    grep -nE 'proxy_pass[[:space:]]+http://[A-Za-z0-9_-]+:[0-9]+' "$file" \
      | grep -vE 'http://(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal):' \
      || true
  )"
  if [[ -n "$static_hits" ]]; then
    red "FAIL: $file has static Docker service upstream(s)."
    printf '%s\n' "$static_hits" >&2
    failures=$((failures + 1))
  fi

  if grep -qE 'proxy_pass[[:space:]]+\$[A-Za-z_][A-Za-z0-9_]*' "$file" \
    && ! grep -qE 'resolver[[:space:]]+127\.0\.0\.11' "$file"; then
    red "FAIL: $file uses variable proxy_pass but does not configure Docker DNS resolver 127.0.0.11."
    failures=$((failures + 1))
  fi
done < <(
  find . \
    \( -name Dockerfile -o -name '*.conf' -o -name '*.nginx' -o -name '*.template' \) \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -print | sort
)

if [[ "$failures" -ne 0 ]]; then
  cat >&2 <<'EOF'

Fix nginx Docker service proxies with the runtime Docker resolver, for example:

  resolver 127.0.0.11 ipv6=off valid=10s;
  set $workgraph_api http://workgraph-api:8080;
  proxy_pass $workgraph_api;

EOF
  exit 1
fi

green "OK: nginx Docker service proxies use runtime Docker DNS."
