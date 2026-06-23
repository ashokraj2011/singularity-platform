# Deployment Test Matrix

Use this runbook to clone the platform into a separate folder and test each
deployment option serially. Do not run the modes at the same time: they share
ports such as `5180`, `8000`, `8080`, `8100`, `3001-3004`, `5432`, and `5434`.
The Docker Compose project is also named `singularity`, so a test clone uses
the same Docker container/volume namespace as your main checkout.

Stop the current stack before testing from another folder:

```bash
cd /Users/ashokraj/Downloads/backupSingularity/singularity-platform
./singularity.sh down || true
bin/docker-core.sh down || true
bin/bare-metal-runtime.sh down || true
bin/bare-metal-apps.sh down || true
```

## Important: Commit First Or Copy The Working Tree

A normal Git clone only contains committed changes. If you want the test clone
to include current local changes, either commit/push first or use
`--copy-working-tree`.

Recommended pushed-clone test:

```bash
cd /Users/ashokraj/Downloads/backupSingularity/singularity-platform
git status --short

bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/singularity-platform-deploy-test \
  --source https://github.com/ashokraj2011/singularity-platform \
  --ref main \
  --reset-target
```

Recommended local dirty-working-tree test:

```bash
cd /Users/ashokraj/Downloads/backupSingularity/singularity-platform

bin/clone-and-test-deployments.sh \
  --copy-working-tree \
  --target /Users/ashokraj/Downloads/singularity-platform-dirty-test \
  --reset-target
```

## Default Automated Matrix

The default matrix runs:

```text
compose-core
compose-runtime
plain-docker
plain-docker-audit
```

Command:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/singularity-platform-deploy-test \
  --reset-target
```

## Full Matrix

The full matrix additionally tries bare-metal and runtime-bridge modes:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/singularity-platform-full-test \
  --reset-target \
  --modes all
```

Bare-metal requires a reachable host Postgres. Defaults are:

```text
BARE_METAL_DB_USER=postgres
BARE_METAL_DB_PASS=postgres
BARE_METAL_DB_HOST=localhost
BARE_METAL_DB_PORT=5432
```

Override them if needed:

```bash
BARE_METAL_DB_USER=ashokraj \
BARE_METAL_DB_PASS=postgres \
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/singularity-platform-full-test \
  --reset-target \
  --modes all
```

## Individual Modes

Docker Compose core:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-compose-test \
  --reset-target \
  --modes compose-core
```

Docker Compose with local optional MCP/LLM runtime profiles:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-compose-runtime-test \
  --reset-target \
  --modes compose-runtime
```

Plain Docker without Compose:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-plain-docker-test \
  --reset-target \
  --modes plain-docker
```

Plain Docker with audit-governance:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-plain-docker-audit-test \
  --reset-target \
  --modes plain-docker-audit
```

Bare-metal apps plus local bare-metal runtime:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-bare-metal-test \
  --reset-target \
  --modes bare-metal
```

Runtime bridge one-machine smoke:

```bash
bin/clone-and-test-deployments.sh \
  --target /Users/ashokraj/Downloads/sg-runtime-bridge-test \
  --reset-target \
  --modes runtime-bridge
```

## Manual Plain Docker Test

Inside any fresh clone:

```bash
bin/docker-core.sh up --build
bin/docker-core.sh seed
bin/docker-core.sh smoke
bin/docker-core.sh nuke --yes
```

With audit-governance:

```bash
bin/docker-core.sh up --build --with-audit
bin/docker-core.sh seed --with-audit
bin/docker-core.sh smoke --with-audit
bin/docker-core.sh nuke --yes
```

## Manual Docker Compose Test

Inside any fresh clone:

```bash
./singularity.sh config init --profile office-laptop
./singularity.sh config mcp-catalog --default-alias mock
./singularity.sh config write
./singularity.sh up
bin/seed-docker.sh
./singularity.sh doctor
./singularity.sh down
```

## Manual Bare-Metal Test

Inside any fresh clone:

```bash
bin/bare-metal-apps.sh up postgres postgres localhost 5432
bin/bare-metal-apps.sh smoke
bin/bare-metal-runtime.sh up
bin/bare-metal-runtime.sh smoke
bin/bare-metal-runtime.sh down
bin/bare-metal-apps.sh down
```

## Cleanup

If a test is interrupted:

```bash
cd /Users/ashokraj/Downloads/singularity-platform-deploy-test

./singularity.sh down || true
bin/docker-core.sh nuke --yes || true
bin/bare-metal-runtime.sh down || true
bin/bare-metal-apps.sh down || true
bin/laptop-bridge.sh box-down || true
```

For Docker volumes, use the mode-specific `nuke`/`down -v` commands only in the
throwaway clone.
