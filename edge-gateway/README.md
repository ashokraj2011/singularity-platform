# Edge Gateway (Legacy Debug Only)

The normal Singularity UI entry point is now **Platform Web**:

```sh
./singularity.sh up
open http://localhost:5180/
```

`agent-and-tools/web` is the canonical frontend. It serves operations, agents,
workflows, workbench, foundry, identity, runtime receipts, and migrated legacy
routes from one Next.js application and one `platform-web` container.

This `edge-gateway` directory is retained only for debugging the old split-UI
topology. It is not part of the default Docker stack, installation guide, or
operator path. The old standalone UI services (`portal`, `workgraph-web`,
`blueprint-workbench`, `user-and-capability`, and `code-foundry-web`) should be
started only with the legacy/debug profile when you intentionally need to
compare migrated screens against their prior implementations.

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

## Local gateway for bare-metal dev (blue Workbench cockpit)

Distinct from the legacy split-UI above: this is a bare-metal **dev convenience** that
runs the genuine `blueprint-workbench` cockpit. On bare-metal, `:5180/workbench` is the
native console; to drive the *real* cockpit — e.g. a CALL_WORKFLOW "Open Workbench"
launch — run a local single-origin gateway that fronts Platform Web and the cockpit:

```sh
bin/local-gateway.sh up        # start cockpit (:5176) + nginx gateway (:8085)
bin/local-gateway.sh status    # health
bin/local-gateway.sh down      # stop both
```

| Port | Serves |
| --- | --- |
| `:8085` | gateway — **enter here** |
| `:5180` | Platform Web (Next) |
| `:5176` | `blueprint-workbench` cockpit (vite dev, base `/workbench/`) |

The gateway (`edge-gateway/local.conf`) routes `/workbench/` → `:5176` (cockpit),
`/workbench/api/*` → `:5180/api/workgraph/*` (reuses Platform Web's proxy), and `/` →
`:5180`. Single origin means the `singularity-portal.auth` token is shared.

- Requires Docker (nginx runs as an `nginx:alpine` container); the host needs no nginx.
- Enter at `http://localhost:8085`, log in **there**, and view runs at `:8085` (change
  `:5180` → `:8085` in the URL). The launch URL is origin-relative, so on `:5180`
  "Open Workbench" opens the native console instead.
- Run `bin/local-gateway.sh up` from your own terminal so the cockpit vite process
  survives.
- `bin/bare-metal-apps.sh` sweeps `:5176`/`:8085` by default — start the gateway *after*
  the stack is up, and set `SINGULARITY_FREE_LEGACY_PORTS=0` if you restart bare-metal
  while it runs.
- Known gap: `/workbench/audit-gov` (the cockpit's governance tab) is not routed yet.

For a complete topology description, see:

- `docs/unified-platform-web.md`
- `docs/platform-handbook.md`
- `docs/hybrid-laptop-deployment.md`
- `docs/laptop-split-deployment.md`
