# M75 — Laptop bridge cutover (finish the M71 architectural shift)

Implementation plan for migrating the laptop mcp-server from the
legacy `executeInvokePayload` agent-loop entry point to the same
`/mcp/tool-run` per-call dispatch contract the platform uses. Closes
the architectural inconsistency the M71 cutover left open: every
laptop currently runs the deprecated all-in-one loop because the
WebSocket bridge protocol never got migrated.

## Why this matters

Today, mcp-server serves two deployment topologies from one binary:

  Platform mode (default, runs in shared compose)
    HTTP: /mcp/tool-run    ← context-fabric dispatches here
    HTTP: /mcp/invoke      ← returns 410 Gone

  Laptop mode (LAPTOP_MODE=true, runs in the user's menu-bar app)
    WS: outbound to platform's /api/laptop-bridge/socket
    On "invoke" frame → executeInvokePayload() runs the full
      legacy agent loop locally (LLM call, tool dispatch, state
      machine, PII mask, sliding window — all 4577 lines of
      invoke.ts logic, running on the user's laptop)

The asymmetry has three real costs:

1. **Two agent loops, one spec.** Platform runs context-fabric's
   governed_step (Python). Laptop runs invoke.ts (TypeScript). Phase
   enforcement, repair caps, path coverage — every M74 fix only
   applies to platform-mode runs. Laptop runs are stuck on the
   pre-M71 behavior.

2. **No quality bar on laptop.** llm_judge, eval feedback, PII mask,
   stagnant detector — none of it fires on laptop runs. They're a
   silent governance bypass.

3. **Two surfaces to maintain.** Every bug fix has to land in both
   loops. The PII regression report (M73-pii-regression.md) is
   actually wrong about scope — it says "the M71 cutover dropped
   multi-turn PII masking" but laptop runs STILL have it. Platform
   runs lost it. We have to fix both topologies to close the gap.

## Current state

```
┌──────────────┐                    ┌────────────────────┐
│ workgraph-   │  POST /execute-    │ context-fabric     │
│ api          │  governed-stage    │ governed_step      │
│              │ ─────────────────► │                    │
└──────────────┘                    │                    │
                                    │ if !use_laptop:    │
                                    │   POST /mcp/       │
                                    │   tool-run ──────► mcp-server (platform)
                                    │                    │   /mcp/tool-run handler
                                    │                    │   dispatches tool, returns
                                    │                    │
                                    │ if use_laptop:     │
                                    │   REGISTRY.invoke ─► laptop_registry
                                    │                    │   sends "invoke" frame
                                    │                    │   to laptop WS
                                    │                    │     │
                                    │                    │     ▼
                                    │                    │  mcp-server (laptop)
                                    │                    │  LaptopRelayClient
                                    │                    │  on "invoke" frame:
                                    │                    │    executeInvokePayload
                                    │                    │    runs full agent loop
                                    │                    │    returns finalResponse
                                    └────────────────────┘
```

The platform path is "CF orchestrates, mcp executes one tool at a
time." The laptop path is "CF hands off, laptop runs everything."
These are different protocols pretending to be one architecture.

## Target state

Single agent loop in CF. Both topologies dispatch tools the same way:

```
                                    ┌────────────────────┐
                                    │ context-fabric     │
                                    │ governed_step      │
                                    │                    │
                                    │ for each tool_call:│
                                    │   if !use_laptop:  │
                                    │     POST mcp:tool-run
                                    │   if use_laptop:   │
                                    │     send tool-run  │
                                    │     frame, await   │
                                    │     response       │
                                    └────────────────────┘
```

Concretely: replace the laptop bridge's "invoke" frame (carries the
full agent loop payload) with a "tool-run" frame (carries one tool
call). The laptop's mcp-server runs ONLY the tool dispatch — same
code as `/mcp/tool-run` already runs on the platform side. The agent
loop, PII mask, stagnant detector, phase machine — all live in CF
and apply to laptop runs identically.

## Protocol design

### Current "invoke" frame (legacy)

```jsonc
{
  "type": "invoke",
  "request_id": "uuid",
  "payload": {
    "systemPrompt": "...",
    "message": "...",
    "tools": [...],
    "modelConfig": {...},
    "runContext": {...},
    "limits": {...},
    "history": [...],
    // ~50 fields, the full /mcp/invoke schema
  }
}
```

Reply (also legacy):

```jsonc
{
  "type": "response",
  "request_id": "uuid",
  "payload": {
    "finalResponse": "...",
    "tokensUsed": {...},
    "modelUsage": {...},
    "pendingApproval": null,
    "verificationReceipts": [...],
    // ~30 fields, the full /mcp/invoke response
  }
}
```

### New "tool-run" frame (target)

```jsonc
{
  "type": "tool-run",
  "request_id": "uuid",
  "payload": {
    "tool_name": "apply_patch",
    "args": {"patch": "..."},
    "work_item_id": "WI-1",
    "workspace_id": null,
    "run_context": {"traceId": "t1", "attemptId": "a2", ...}
  }
}
```

Reply:

```jsonc
{
  "type": "response",
  "request_id": "uuid",
  "payload": {
    "result": {...},
    "duration_ms": 1234,
    "tool_invocation_id": "ti-1",
    "tool_success": true,
    "tool_error": null
  }
}
```

This mirrors the HTTP `/mcp/tool-run` payload/response 1:1. The
laptop's `LaptopRelayClient` becomes a thin dispatcher: receive
tool-run frame → call the same internal handler as the HTTP route →
send response frame.

### Backward compatibility

A laptop running the OLD binary still sends "invoke" frames and
expects "invoke" responses. The platform-side bridge has to handle
both:

- **Phase A (this work):** Add support for "tool-run" frames on
  both sides. Keep "invoke" handlers alive. New laptops use
  "tool-run"; old laptops keep working via "invoke" until upgraded.
  Bridge advertises supported frame types in the "hello" handshake.

- **Phase B (~1 release later):** Deprecate "invoke" frames with a
  warning in the laptop's logs. Operators see "your laptop is on
  the legacy protocol; upgrade for governance enforcement".

- **Phase C (~2 releases later):** Remove "invoke" handlers. At
  that point invoke.ts can actually shrink.

This plan covers Phase A only. Phase B + C are follow-ups when
operator inventory shows zero old laptops.

## Migration slices

### Slice 1 — Define the new frame types (~half day)

Files:
- `mcp-server/src/laptop/envelopes.ts` — add `ToolRunFrame` +
  `ToolRunResponseFrame` types alongside the existing `InvokeFrame`.
- `mcp-server/src/laptop/envelopes.ts` — extend `HelloFrame` to
  advertise `supported_frame_types: ["invoke", "tool-run"]` so the
  bridge can negotiate.
- `mcp-server/test/laptop/envelopes.test.ts` — round-trip encode/
  decode for the new shapes.

No behavior change yet. Just the types + encoder/decoder ready for
both sides to use.

### Slice 2 — Laptop-side handler (~1 day)

Files:
- `mcp-server/src/laptop/relay-client.ts` — handle "tool-run" frames
  in addition to "invoke" frames. The handler calls the existing
  tool-dispatch function (same as `/mcp/tool-run` HTTP route), wraps
  the result in a response frame.
- New helper: extract the inner tool-dispatch function from
  `mcp/tool-run.ts` so both the HTTP route and the WS handler share
  one implementation.
- `mcp-server/test/laptop/relay-client.test.ts` — test that a
  tool-run frame produces the expected response frame.

After this slice, a laptop CAN handle either frame type. The
platform still only sends "invoke" so behavior is unchanged.

### Slice 3 — Platform-side dispatch path (~1 day)

Files:
- `context-fabric/services/context_api_service/app/laptop_registry.py`
  — new method `dispatch_tool_via_laptop(user_id, tool_name, args,
  run_context, timeout)`. Implementation parallels the existing
  `invoke()` method but sends a tool-run frame and expects a
  response of shape `{result, duration_ms, tool_invocation_id,
  tool_success, tool_error}`.
- `context-fabric/services/context_api_service/app/governed/
  laptop_dispatcher.py` — new function
  `dispatch_tool_via_laptop(...)` that mirrors `dispatch_via_laptop`
  but takes a single tool call instead of a full invoke payload.
- `context-fabric/services/context_api_service/app/governed/
  dispatch.py` — extend `dispatch_tool` to take an optional
  `prefer_laptop` flag. When set + laptop available, route the
  single tool call through the laptop bridge instead of HTTP.
- Test coverage: mock the laptop_registry method, assert
  governed_step dispatches each tool via the laptop path when
  prefer_laptop is True.

After this slice, governed_step works through the laptop bridge end
to end. The legacy `executeInvokePayload` path is no longer the
laptop entry — but it's still alive for backward compat with old
laptops.

### Slice 4 — Wire prefer_laptop into the governed flow (~half day) ✅ SHIPPED

Status: ✅ landed 2026-05-23. Files touched:

- `context-fabric/services/context_api_service/app/governed/loop.py`
  — reads `prefer_laptop` from run_context, looks up `user_id` /
  `userId`, threads a string `laptop_user_id` into `dispatch_tool`
  when (and only when) `prefer_laptop is True` AND a user_id is
  present. Strict `is True` check rejects truthy-but-not-bool
  values ("true", 1, etc.) so a serialisation bug upstream cannot
  silently flip routing.
- `workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts`
  — when launching a governed coding stage, reads
  `session.metadata.preferLaptop` (operator toggle, no schema
  migration) and conditionally spreads `prefer_laptop` into the
  runContext object via `readPreferLaptopFlag()`. Key is omitted
  entirely when undefined so dispatch.py's strict check stays tight.
- Test: `context-fabric/tests/test_governed_loop_laptop_routing.py`
  — 11 cases covering the routing decision matrix (True+user_id,
  True+no user_id, False+user_id, missing, truthy-non-bool,
  camelCase alias, int coercion, no run_context).

End-to-end behaviour: a stage launched with
`session.metadata.preferLaptop=true` now dispatches every tool call
via the laptop WebSocket bridge instead of the shared mcp-server.
HTTP fallback fires automatically when no bridge is connected
(`_LaptopUnavailable` → HTTP path, per Slice 3).

### Slice 5 — Audit + telemetry parity (~half day)

The legacy invoke loop emits `cf.invoke.via_laptop` audit events
(per-invoke, with device_id + device_name). The new path needs
per-tool-call audit so operators can still see "this tool ran on
the user's laptop, not the shared runner."

Files:
- `context-fabric/services/context_api_service/app/governed/loop.py`
  — when dispatching a laptop tool, emit
  `governed.tool_dispatched_via_laptop` with device_id + tool_name.
- audit-gov UI: add laptop-badge rendering on the per-tool view
  (parity with the existing per-invoke badge).

### Slice 6 — Cutover docs + flag (~half day)

- `docs/M75-laptop-bridge-cutover.md` (this file) — update to
  "Phase A complete" with a section pointing at Phase B/C
  prerequisites.
- `singularity-desktop/README.md` — note the new protocol is
  default; operators on old binaries get a deprecation warning in
  their logs.
- env flag for emergency rollback:
  `LAPTOP_USE_LEGACY_INVOKE=true` falls back to the old path. If
  the new dispatch has a bug in production, operators can flip the
  flag without a re-deploy.

## Cross-cutting decisions

These need an answer before slices start, not discovered mid-impl.

1. **Latency trade-off.** Today a laptop stage = 1 round-trip to
   the laptop (invoke). The new path = N round-trips, one per tool
   call. A 25-turn stage with 3 tools/turn = 75 round-trips instead
   of 1. WebSocket framing is cheap (~1ms per frame) but the agent
   loop has to wait for each response before issuing the next tool
   call. Realistic worst-case: +500ms per stage for a noisy local
   network, +2s for a flaky one.

   Recommend: ship Phase A as-is, measure p95 latency from
   production operators, if regression > 25% then add tool-batching
   ("here are 3 tools to run in parallel") as a Phase A.5.

2. **Concurrency.** The legacy invoke serialised tool calls per
   laptop (one invoke at a time). The new protocol could pipeline
   multiple tool calls in flight. For Phase A: keep serial — one
   tool-run frame in flight at a time per laptop. Pipelining is a
   Phase B optimisation, not a correctness requirement.

3. **PII mask location.** Today the laptop's invoke.ts runs the
   PII tokenMap locally. After cutover, PII mask is implemented in
   CF (task #93, not yet shipped). Means: until task #93 lands,
   laptop runs LOSE PII masking when they migrate. Order matters —
   ship #93 BEFORE Slice 4 (the platform-side flag flip).

4. **State persistence across pause/resume.** The legacy invoke
   serialised the full LoopState (history, piiTokenMap, repair
   count) into the pause envelope. The new path serialises
   PhaseState in CF instead. The state machines differ. Migration
   has to translate any in-flight pauses on laptop runs at the
   cutover moment, OR refuse to resume pre-M75 pauses and force a
   restart. Recommend: refuse to resume, document in release notes.

5. **Hello frame protocol version.** Bump WS handshake version so
   old platform + new laptop AND new platform + old laptop both
   correctly degrade. A new laptop talking to an old platform sees
   "invoke" frames only and runs the legacy path. An old laptop
   talking to a new platform gets "invoke" frames (platform falls
   back when laptop advertises no tool-run support).

## Effort summary

| Slice | Effort | Depends on |
|-------|--------|------------|
| 1. Frame types | half day | nothing |
| 2. Laptop-side handler | 1 day | slice 1 |
| 3. Platform-side dispatch | 1 day | slice 1 |
| 4. Wire prefer_laptop in governed | half day | slices 2+3, task #93 |
| 5. Audit/telemetry parity | half day | slice 4 |
| 6. Cutover docs + flag | half day | slice 5 |
| **Phase A total** | **~4 days** | (task #93 must ship first) |
| Phase B (deprecate invoke frames) | 1 day | 1+ release in production |
| Phase C (delete invoke.ts loop) | 1 day | operator inventory shows zero old laptops |

## Risks

- **Hidden state in invoke.ts.** Multiple PR-era patches (M68/M70.x)
  added behavior to the legacy loop that may not exist in
  governed_step yet. The M74 work brought most of it over; spot
  checks needed for PII (#93), formal-verifier integration, and
  the M70.6 git push fix.
- **Network reliability.** N round-trips per stage is more
  brittle than 1. Mitigations: per-tool timeout with fallback to
  HTTP path, exponential retry on transient WS errors, clear
  operator-visible error when bridge drops mid-stage.
- **No protocol version negotiation today.** The hello frame
  doesn't carry capability bits. Slice 1 has to add them or both
  sides must default to legacy behavior on unknown frame types.
  Pick this in the protocol design, not at implementation.

## What this doesn't cover

- PII mask implementation (task #93) — prerequisite, not in scope.
- Operator-curation UI for Phase 2C of M74 — independent workstream.
- SWE-bench-lite capability harness (Phase 4 of M74) — independent.
- Migration of in-flight pauses across the cutover boundary —
  decided to refuse + restart rather than translate (cross-cutting
  decision #4 above).

## Where to start

Slice 1 is the cheapest concrete commitment — pure protocol type
definition + tests, no behavior change. Lets us iterate on the
frame shape before locking it in across both sides.

Recommend: **start Slice 1**, then pause for a design review of
the cross-cutting decisions before Slice 2.
