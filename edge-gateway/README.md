# Edge Gateway (Legacy Debug Only)

The normal Singularity UI entry point is now **Platform Web**:

```sh
./singularity.sh up
open http://localhost:5180/
```

`agent-and-tools/web` is the canonical frontend. It serves operations, agents,
workflows, workbench, foundry, identity, runtime receipts, and migrated legacy
routes from one Next.js application and one `platform-web` container.

This `edge-gateway` directory is retained only as an optional legacy/debug
multi-app gateway. It is not part of the default Docker stack, installation
guide, or operator path, and it is not needed for normal operation. The platform
consolidation has since collapsed the old split UIs: `singularity-portal`,
`user-and-capability` (UserAndCapability), and `code-foundry-web` have been
deleted, while `workgraph-web` and `blueprint-workbench` are now compiled into
Platform Web as library source rather than standalone apps. Use the
`frontend-legacy` debug profile only when you intentionally need the historical
multi-app gateway shape.

## Current Routing

Use these Platform Web routes instead of the historical edge-gateway prefixes:

| Current route | Surface |
| --- | --- |
| `/` | Platform home |
| `/operations` | Operations, setup, readiness, trust |
| `/agents` | Agent Studio, tools, prompt composer, runtime receipts |
| `/workflows` | Workgraph templates, designer, runs, artifacts |
| `/workbench` | Blueprint Workbench |
| `/foundry` | Code Foundry |
| `/identity` | IAM, users, teams, roles, capabilities |

Legacy paths redirect into the canonical route tree from Platform Web. For
example, `/agent/agent-studio` redirects to `/agents/studio`, `/workflow/*`
routes to the migrated workflow surfaces, and `/login` redirects to
`/identity/login`.

## When To Use This Directory

Use `edge-gateway` only when you are investigating old split-frontend behavior.
For normal development and deployment, update Platform Web routes, API proxies,
and docs instead.

Recommended verification commands:

```sh
npm run build --workspace=web
python3 bin/check-platform-web-routes.py --base-url http://localhost:5180
node bin/check-platform-web-ui.mjs
./singularity.sh doctor
```

## Blue Workbench cockpit (now in-process)

The bare-metal `local-gateway.sh` + `:5176` + `:8085` setup that used to front the
`blueprint-workbench` cockpit has been **retired**. The cockpit now runs **in-process**
as Platform Web's `/workbench` route (same origin, `:5180`), so the auth token carries
and a CALL_WORKFLOW "Open Workbench" launch opens the blue cockpit directly. `/workbench`
*is* the blue cockpit and handles all views internally; the old green native console at
`/workbench/<view>` was removed. Just open `http://localhost:5180/workbench` — no gateway,
no separate vite server.

The cockpit's API paths are proxied same-origin by Platform Web (`next.config.mjs`):
`/workbench/api/*` → `/api/workgraph/*` and `/workbench/audit-gov/*` → `/api/audit-gov/*`.

For a complete topology description, see:

- `docs/unified-platform-web.md`
- `docs/platform-handbook.md`
- `docs/hybrid-laptop-deployment.md`
- `docs/laptop-split-deployment.md`
