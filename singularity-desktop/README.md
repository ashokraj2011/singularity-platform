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
- Workbench Neo: `http://localhost:5176/?ui=neo`
- Copilot binary: `copilot`

All of these can be changed in the app Settings screen.

## Boundaries

- Renderer code does not get direct shell access.
- Electron main process owns Copilot process execution, repo picking, local evidence collection, and notifications.
- Workbench Neo is embedded as a web surface for v1.
- Direct Copilot mode is the default local execution path.
