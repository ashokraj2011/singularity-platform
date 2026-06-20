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

For a complete topology description, see:

- `docs/unified-platform-web.md`
- `docs/platform-handbook.md`
- `docs/hybrid-laptop-deployment.md`
- `docs/laptop-split-deployment.md`
