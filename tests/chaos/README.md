# Chaos smoke harness — M65 Slice 3B

End-to-end tests that exercise the platform's failure-handling chain
against a live stack with the `mock` LLM provider configured to flake.

## What this catches

The M64 incident — Anthropic 529 cascading through a timeout-math
bug — was the kind of thing that should have been caught pre-launch.
This suite ships permanent regression coverage for that class of bug:

- Gateway retry envelope absorbs transient 529s/503s.
- Errors that survive retries surface to consumers with the correct
  structured error code (`LLM_PROVIDER_OVERLOADED`, etc.), not the
  generic `MCP_INVOKE_FAILED`.
- mcp-server's wait on the gateway is strictly longer than the
  gateway's retry envelope — i.e. M64's timeout math holds.

## Usage

```bash
# Bring up the full stack first
docker compose --profile full up -d

# Wait for everything healthy
./bin/wait-for-healthy.sh   # or just curl /health on each port

# Run the suite
pytest tests/chaos/ -v
```

CI (M65 Slice 3C) runs this nightly against a freshly-spun stack.
Not PR-blocking — caught regressions surface as a Slack/email
notification, not a merge gate.

## Adding a new chaos case

1. Add a new mock alias to `bin/bare-metal.sh`'s
   `mcp-models.json` heredoc (and your local
   `.singularity/mcp-models.json` for dev).
2. Add the alias to `mock.py:_maybe_inject_failure` if it needs a new
   pattern not covered by `mock-fail-{N}` or `mock-fail-{N}-{K}`.
3. Write a test in `test_provider_flake.py` that POSTs to the
   gateway (or up the chain) and asserts the expected end-to-end
   behaviour.
