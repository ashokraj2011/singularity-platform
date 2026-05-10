# Context Fabric Architecture

## MVP service split

```text
Client / Agent / App
        |
        v
context-api-service
        |
        +--> context-memory-service
        |       +--> conversation messages
        |       +--> summaries
        |       +--> memory items
        |       +--> context packages
        |
        +--> llm-gateway-service
        |       +--> mock / OpenRouter / OpenAI-compatible / Ollama
        |
        +--> metrics-ledger-service
                +--> raw vs optimized token savings
```

## Context optimization flow

1. Save incoming user message.
2. Refresh rolling summary when threshold is met.
3. Build raw context from full session history.
4. Build optimized context based on mode.
5. Count raw and optimized tokens.
6. Store context package.
7. Call selected LLM provider.
8. Save assistant response.
9. Record token savings.

## Optimization modes

| Mode | Behavior |
|---|---|
| none | Full raw context |
| conservative | Rolling summary + last 12 messages + top 10 memories |
| medium | Rolling summary + last 6 messages + top 5 memories |
| aggressive | Rolling summary + last 3 messages + top 3 memories |
| ultra_aggressive | Minimal summary + last message + top 2 memories |
| code_aware | Placeholder for future AST/code slicing |
| audit_safe | More recent messages and more memory |

## Next design upgrades

- Add agent context profiles.
- Add policy learner.
- Add quality evaluator.
- Add pgvector.
- Add code-aware context slicing.
- Add receipt hash chain.
