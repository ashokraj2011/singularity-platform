# Singularity Code Foundry

> Implements `/Users/ashokraj/Downloads/meta/deterministic_code_layer_spec_v2.md`.
> Tracking milestone plan at
> `/Users/ashokraj/.claude/plans/in-the-singularityneonew-i-agile-fern.md`.

A deterministic-first code generation layer for SingularityNeo. The
Foundry compiles a structured service specification into a governed
baseline (controllers, DTOs, security, audit, observability, retry,
tests, OpenAPI) using versioned templates, then invokes an LLM only
for narrowly-scoped patch tasks inside typed `<llm-editable>` regions.
Every patch passes a mechanical guard before it touches disk.

## Layout

```
singularity-code-foundry/
├── packages/
│   └── feature-flags/      M42.0 — shared admin-gate client
└── apps/
    └── code-foundry-api    backend service
```

The Foundry **frontend** is not a separate app — the Foundry UI is native
in platform-web at `/foundry` (see `agent-and-tools/web/src/app/foundry/`).
The former standalone `apps/code-foundry-web` has been removed.

## Admin gate

Every entry point checks `code_foundry.enabled` (and the relevant
sub-flag) via the shared `@singularity-code-foundry/feature-flags`
client. Default is OFF; flip it on the Operations page or via
`PUT /api/admin/feature-flags/code_foundry.enabled`.
