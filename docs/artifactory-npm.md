# Installing Node packages from an office Artifactory

**Goal:** in an office where packages come from Artifactory (not the public npm
registry), make every Node install resolve from Artifactory — and stop hitting
"version X not available" without having to downgrade pins.

## TL;DR

1. Use an Artifactory **virtual** npm repo as your registry (local repo +
   remote-proxy of `registry.npmjs.org`). A version that isn't mirrored yet is
   fetched from upstream **on first request**, so a pinned-but-unmirrored
   version usually just works — no version edits needed.
2. Point installs at it via `.npmrc`. Token comes from env, never committed.
3. For Docker image builds, pass the registry + token as build args and write
   `.npmrc` before the install step.

## Why this is the right fix (vs. loosening versions)

This repo's installs are already forgiving: most services run `npm install`
(re-resolves from `package.json`, not `npm ci`), and the pnpm apps run
`pnpm install --frozen-lockfile || pnpm install` (falls back to a fresh
resolve). So the failure you hit is almost always *"the registry I'm pointed at
doesn't have this version"* — a **registry** problem, not a version-range
problem. A virtual repo that proxies upstream fixes it at the source.

Loosening pins (carets → wider ranges, or dropping the floor to accept a
*lower* version) trades reproducibility for resilience and can silently run
untested versions. Only reach for that if your Artifactory is a hard allowlist
with **no** upstream proxy. (See "If your Artifactory can't proxy upstream".)

## Local / host installs

```bash
export ARTIFACTORY_NPM_REGISTRY="https://artifactory.your-co.com/artifactory/api/npm/npm-virtual/"
export ARTIFACTORY_NPM_TOKEN="<artifactory identity token, or base64 of user:password>"
bin/use-artifactory.sh           # writes ./.npmrc (env-var mode; no token stored)
bin/use-artifactory.sh --all     # also writes .npmrc into every Node workspace
```

`.npmrc` is gitignored. In env-var mode the file contains literal
`${ARTIFACTORY_NPM_TOKEN}`; npm/pnpm interpolate it from your shell at install
time, so nothing secret is written to disk.

## Docker image builds

Installs run during `docker build`, so each image needs `.npmrc` available
during its install step. Mirror the existing build-arg convention (e.g. the
`AUDIT_GOV_TOKEN` ARG in `workgraph-studio/apps/blueprint-workbench/Dockerfile`).

Reference pattern — **npm** service (e.g. `mcp-server/Dockerfile`):

```dockerfile
FROM base AS deps
ARG ARTIFACTORY_NPM_REGISTRY
ARG ARTIFACTORY_NPM_TOKEN
COPY package.json ./
# Write a throwaway .npmrc INTO THIS LAYER ONLY (resolved token). Because it's
# in the deps stage and node_modules is copied forward (not .npmrc), the token
# does not reach the final image.
RUN printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' \
      "$ARTIFACTORY_NPM_REGISTRY" \
      "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" \
      "$ARTIFACTORY_NPM_TOKEN" > .npmrc \
 && npm install --no-audit --no-fund \
 && rm -f .npmrc
```

Reference pattern — **pnpm** app (e.g. `workgraph-studio/apps/web/Dockerfile`):

```dockerfile
FROM base AS deps
ARG ARTIFACTORY_NPM_REGISTRY
ARG ARTIFACTORY_NPM_TOKEN
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# ...COPY the per-package package.json files as today...
RUN printf 'registry=%s\n//%s:_authToken=%s\n' \
      "$ARTIFACTORY_NPM_REGISTRY" \
      "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" \
      "$ARTIFACTORY_NPM_TOKEN" > .npmrc \
 && (pnpm install --frozen-lockfile || pnpm install) \
 && rm -f .npmrc
```

Better still, use BuildKit secrets so the token never enters a layer at all:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm install --no-audit --no-fund
# build: docker build --secret id=npmrc,src=$PWD/.npmrc ...
```

Pass the args via compose:

```yaml
services:
  mcp-server:
    build:
      context: ./mcp-server
      args:
        ARTIFACTORY_NPM_REGISTRY: ${ARTIFACTORY_NPM_REGISTRY}
        ARTIFACTORY_NPM_TOKEN: ${ARTIFACTORY_NPM_TOKEN}
```

This PR wires the pattern into a few **reference** Dockerfiles (one npm, one
npm-workspaces, one pnpm). Roll it out to the rest by copying the same 3 lines;
they're additive and no-op when the ARGs are empty (falls back to the default
registry), so they're safe to land before the office switch-over.

## If your Artifactory can't proxy upstream (hard allowlist)

Then a missing pin genuinely can't be installed, and you have two options:

1. **Mirror it** — ask the Artifactory admins to add the pinned versions. Use
   the gap-detector approach: list every dependency + version and check each
   against Artifactory. (Ask and we'll add `bin/check-artifactory-deps.sh`.)
2. **Loosen ranges** to accept whatever Artifactory has, including lower
   versions. This loses the version floor and reproducibility — do it
   deliberately, per-package, not blanket. Not done here by default.

## Verifying

```bash
# After configuring, confirm npm sees Artifactory:
npm config get registry
npm view express version --registry "$ARTIFACTORY_NPM_REGISTRY"   # should resolve
```
