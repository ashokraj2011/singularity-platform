# ADR 0001: M35 Hybrid Learning

## Status

Accepted.

## Context

M35 needs closed-loop learning without creating a second prompt lesson system. Prompt Composer already owns `EngineLesson` retrieval and the `GLOBAL_LESSON` prompt layer. The new learning-service adds run summaries, prior failure summaries, and reusable capability patterns.

## Decision

Use a hybrid model:

- `agent-and-tools/apps/learning-service` owns summary and pattern APIs on port `3006`.
- Prompt Composer keeps `EngineLesson` as the canonical prompt-lesson store.
- Prompt Composer queries learning-service first for `PRIOR_FAILURE_SUMMARY` and `LEARNED_PATTERNS`, then merges existing `GLOBAL_LESSON` retrieval.
- If learning-service is unavailable, prompt assembly degrades gracefully and emits a warning instead of failing the run.

## Consequences

This keeps current Engine lessons compatible while giving the platform a dedicated learning API for SDK, MCP tools, and Run Insights. The merge order is explicit and avoids direct writes from learning-service into Prompt Composer-owned tables.
