#!/bin/sh
# Entry shim for the wgvm OCI image. Runs the pre-bundled single-file CLI with
# plain node — no build step, no dependencies. All args pass straight through:
#   docker run --rm wgvm run /data/image.wgvm --state /data/run.db
exec node /app/wgvm.mjs "$@"
