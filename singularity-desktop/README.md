# Singularity Desktop Workbench

Standalone Electron desktop app for local WorkItem execution.

This app is intentionally outside `workgraph-studio` so it can be developed,
packaged, and released independently from the Workgraph web workspace.

## Start In Development

```bash
cd /Users/ashokraj/Downloads/backupSingularity/singularity-platform/singularity-desktop
pnpm install
pnpm dev
```

The Electron renderer runs on `http://127.0.0.1:5188` during development.

## Build

```bash
cd /Users/ashokraj/Downloads/backupSingularity/singularity-platform/singularity-desktop
pnpm build
pnpm start
```

## Runtime Connections

By default the app connects to:

- Singularity API: `http://localhost:8080`
- Workbench Neo: `http://localhost:5180/workbench?ui=neo`
- Copilot binary: `copilot`

All of these can be changed in the app Settings screen.

## Boundaries

- Renderer code does not get direct shell access.
- Electron main process owns Copilot process execution, repo picking, local evidence collection, and notifications.
- Workbench Neo is embedded as a web surface for v1.
- Direct Copilot mode is the default local execution path.

## Laptop bridge protocol (M75, 2026-05)

When the desktop app launches a local mcp-server, that mcp-server can
register with the platform's context-fabric over a WebSocket bridge
(`POST /laptop/bridge`, then long-lived WS). Two frame types are now
in scope:

- `invoke` — legacy, full agent-loop payload runs locally inside
  `executeInvokePayload()`. Still supported for backward compat
  with desktops on older binaries.
- `tool-run` — per-tool dispatch (M75 Slice 2). The platform's
  governed loop sends one frame per tool call, the laptop runs
  just the tool, and returns `{result, duration_ms,
  tool_invocation_id, tool_success, tool_error}`.

The desktop advertises `supported_frame_types: ["invoke",
"tool-run"]` in its `hello` frame so the platform can pick the
right transport. Old desktops (without the field) get treated as
`["invoke"]` only.

### Emergency rollback (platform side)

If a production bug appears in the per-tool dispatch path, operators
can set `LAPTOP_USE_LEGACY_INVOKE=true` on the context-fabric
container. CF will force every governed-loop tool call onto the
shared HTTP mcp-server (the laptop bridge is bypassed) until the
flag is cleared. This is a CF env, not a desktop env — no
re-install or new build is needed.
