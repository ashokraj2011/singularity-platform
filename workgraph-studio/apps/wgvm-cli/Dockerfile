# ─────────────────────────────────────────────────────────────────────────────
# wgvm — portable Workflow VM runner as a zero-dependency OCI image.
#
# The CLI (plus @workgraph/vm and @workgraph/engine) is bundled into a single
# self-contained ESM file with esbuild, so the image needs no npm/pnpm install,
# no tsx and no registry access — only Node's built-ins (incl. node:sqlite).
#
# 1) Build the bundle on the host (writes apps/wgvm-cli/dist/wgvm.mjs):
#      pnpm --filter @workgraph/wgvm-cli bundle
# 2) Build the image (context = workgraph-studio/):
#      docker build -f apps/wgvm-cli/Dockerfile -t wgvm:latest .
# 3) Run a workflow image:
#      docker run --rm -v "$PWD:/data" wgvm:latest \
#        run /data/demo.wgvm --inputs /data/inputs.json --state /data/run.db
#
# Optionally bake a specific .wgvm into the appliance:
#      docker build -f apps/wgvm-cli/Dockerfile --build-arg WGVM_IMAGE=demo.wgvm \
#        -t my-workflow:latest .
#      docker run --rm my-workflow:latest run /app/image.wgvm
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app
COPY apps/wgvm-cli/dist/wgvm.mjs /app/wgvm.mjs

# Optionally bake a pre-built workflow image into the container at /app/image.wgvm.
ARG WGVM_IMAGE=""
COPY apps/wgvm-cli/docker-entry.sh /usr/local/bin/wgvm-entry
RUN chmod +x /usr/local/bin/wgvm-entry && \
    if [ -n "$WGVM_IMAGE" ] && [ -f "apps/wgvm-cli/$WGVM_IMAGE" ]; then \
      cp "apps/wgvm-cli/$WGVM_IMAGE" /app/image.wgvm; \
    fi

ENTRYPOINT ["wgvm-entry"]
CMD ["--help"]
