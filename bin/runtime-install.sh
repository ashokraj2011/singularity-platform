#!/usr/bin/env bash
set -euo pipefail

# Installs the source-compatible runtime CLI. Release packaging can replace the
# symlink with a signed bundle without changing the operator-facing command.

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
FORCE=false

usage() {
  cat <<'USAGE'
Usage: bin/runtime-install.sh [--source PATH] [--bin-dir PATH] [--force]

Install the `singularity-runtime` command for the current user. The runtime
processes still run from the source checkout, while tokens stay in the OS
credential store.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$(cd "${2:?missing value}" && pwd)"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?missing value}"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[ -x "$SOURCE/bin/singularity-runtime" ] || { echo "missing $SOURCE/bin/singularity-runtime" >&2; exit 1; }
mkdir -p "$BIN_DIR"
TARGET="$BIN_DIR/singularity-runtime"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  [ "$FORCE" = true ] || { echo "$TARGET already exists; use --force" >&2; exit 1; }
  rm -f "$TARGET"
fi
ln -s "$SOURCE/bin/singularity-runtime" "$TARGET"
echo "Installed $TARGET"
case ":${PATH}:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to PATH, then run: singularity-runtime doctor" ;; esac
