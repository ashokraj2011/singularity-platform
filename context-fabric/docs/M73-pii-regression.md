# M71 cutover regression: multi-turn PII masking

**Status**: ✅ **FIXED.** CF-side mask landed via task #93. See
`context-fabric/services/context_api_service/app/governed/pii_mask.py`
+ wiring in `governed/loop.py`. The legacy laptop-mode invoke loop
keeps its own TS implementation until M75 Slice 4 retires it.
**Investigated**: 2026-05-23.
**Fixed**: 2026-05-23 (same day — short cycle because the design doc
below picked the right option).
**Source code searched at HEAD**: `main` (commit `12ef7b0` at time of report).

## TL;DR

Under the legacy `/mcp/invoke` path, mcp-server maintained a per-session
`piiTokenMap` that masked PII in tool outputs before the LLM saw them and
unmasked it again before downstream tools executed. The map persisted
across turns within one invoke call AND across pause/resume.

After the M71 cutover:

- `/mcp/invoke` returns `410 MCP_INVOKE_DEPRECATED`.
- The new path is `context-fabric → POST /mcp/tool-run → mcp-server`.
- `/mcp/tool-run` is stateless per call. No `piiTokenMap` enters or leaves.
- `context-fabric/services/context_api_service/app/governed/` has **zero**
  references to mask / unmask / pii / tokenMap.
- The mask/unmask infrastructure in `mcp-server/src/security/{mask,
  pii-detector, pii-ner}.ts` is still present but is now dead code on
  the live path.

**Net effect**: PII flows from tool output → context-fabric → LLM
provider → back through CF → next /mcp/tool-run **in cleartext, end-to-end**.
Customer-data stages that relied on the M39.x masking design are no longer
protected.

## Evidence

### Old path (still in tree, returns 410)

`mcp-server/src/mcp/invoke.ts`:

```typescript
// LoopState carries the token map across every turn
interface LoopState {
  ...
  piiTokenMap: Record<string, string>;
}

// Every tool OUTPUT is masked before the LLM sees it
function applyOutputMaskIfNeeded(state, desc, output) {
  if (!piiMaskingEnabled(state, desc)) return output;
  const r = maskPii(output, state.piiTokenMap);
  state.piiTokenMap = r.tokenMap;  // map grows monotonically
  // ...emit pii.masked audit event...
  return r.masked;
}

// Every tool INPUT is unmasked before dispatch
function applyArgsUnmaskIfNeeded<T>(state, args) {
  if (Object.keys(state.piiTokenMap).length === 0) return args;
  const out = unmaskPiiInArgs(args, state.piiTokenMap);
  // ...emit pii.unmasked audit event...
  return out;
}

// The map even survives /mcp/invoke pause/resume:
// line 2600 — pii_token_map serialized into the resume envelope
// line 3342 — read back when resuming
```

The token map design assumed multi-turn from the start. `[EMAIL_1]` was
"always the first email in the text", which only stays true if the same
map persists. Per the mask.ts docstring:

> `{ "[EMAIL_1]": "a@b.com", "[EMAIL_3]": ... }  →  next is [EMAIL_4]`

### New path (live)

`mcp-server/src/mcp/tool-run.ts` — **184 lines, zero PII references**:

```bash
$ grep -nE "(mask|unmask|pii)" mcp-server/src/mcp/tool-run.ts
# (no output)
```

`mcp-server/src/tools/` (the actual tool implementations) — also zero
references.

`context-fabric/services/context_api_service/app/governed/` — also zero
references:

```bash
$ grep -rnE "(mask|unmask|tokeniz|deidenti|pii)" \
    context-fabric/services/context_api_service/app/governed/
# (no output)
```

So the masking that used to happen at `invoke.ts:4177` no longer happens
anywhere on the live request path.

## Why "intra-call only" is not enough

A common workaround would be to mask inside one `/mcp/tool-run` call —
output of the tool gets masked, args of the same tool get unmasked. But
look at how the original was used:

1. Turn N: tool `lookup_customer` returns `{email: "a@b.com"}`.
   Masked to `{email: "[EMAIL_1]"}`. LLM sees `[EMAIL_1]`.
2. Turn N+1: LLM emits tool call `send_followup({to: "[EMAIL_1]"})`.
   `unmaskPiiInArgs` substitutes `a@b.com` before dispatch.

That's two `/mcp/tool-run` calls. Without a token map persisted
**between** them, the LLM's emitted `[EMAIL_1]` is either (a) treated as
a literal string and the followup is sent to a broken address, or (b)
the LLM, knowing the substitution won't happen, just emits the real
email — defeating the whole point of masking.

Intra-call-only masking only protects single-tool outputs from leaking
into logs/audit. It does **not** keep PII out of the LLM context.

## What needs to be designed

The fix is non-trivial because the new architecture is structurally
stateless per `/mcp/tool-run`. Three options:

### Option A — Persist tokenMap in context-fabric per stage

`StageState` (or the equivalent governed loop state) carries
`pii_token_map: dict[str, str]`. Context-fabric does the mask/unmask on
its side of every tool call:

- Pre-call: `args = unmask_args(args, state.pii_token_map)` → POST to mcp-server.
- Post-call: `(output, new_map) = mask_output(output, state.pii_token_map)` → update state, hand masked output to LLM.

Requires moving the regex+NER detection into Python (or exposing it via
an HTTP endpoint on mcp-server). The Python port is small (the regex
patterns + Presidio-equivalent NER) but adds a dep.

### Option B — mcp-server provides mask/unmask as RPC endpoints

CF calls `POST /mcp/pii/mask` after each `/mcp/tool-run`, and
`POST /mcp/pii/unmask` before each. mcp-server keeps the tokenMap in a
short-TTL cache keyed by `(session_id, capability_id)`.

Pros: keeps the masking logic in TypeScript (no Python port).
Cons: two extra round-trips per tool call. The cache needs durable
storage if stage_driver pauses for human approval (multi-hour gap).

### Option C — Pass tokenMap on every `/mcp/tool-run` and back in response

`/mcp/tool-run` accepts an optional `pii_token_map` field and returns an
updated one. CF threads it through. mcp-server does the actual mask/unmask
on each call, but doesn't store any state.

Pros: stateless on mcp-server side; no new endpoints.
Cons: tokenMap grows monotonically across a stage; size is bounded by
distinct PII values seen in the run. Sending the map over the wire on
every call is N² in tool output size if values accumulate.

## Recommendation

Option A (CF-side state). Reasoning:

- CF already owns `governed/loop.py` state for the stage. Adding one
  more dict to it is cheap.
- mcp-server stays "dumb runner" per the M71 design intent.
- The mask/unmask is fast — regex matching on a 10 KB tool output is
  sub-millisecond. NER (when enabled) is the slow part and only runs
  on output, so it stays on whichever side has the model loaded.
- Pause/resume just persists `pii_token_map` alongside the rest of
  StageState. No new durable-cache problem.

The Python port of `mask.ts` is the only new code: maybe 60 lines for
the regex baseline, optional shim out to Presidio for NER. The
audit events stay the same shape.

## Severity assessment

**High** for any deployment that handles regulated PII (PHI, PCI,
GDPR-scoped EU data). The fix is meaningful work (~1-2 days for the
Python port + integration + tests) but bounded.

**Low** for code-only deployments where the only PII-shaped text the
agent sees is in commit metadata (author email) — that path's protection
matters but the blast radius is small.

The right operational move while the fix is in flight is to (1) raise
the issue to anyone running customer-data stages, and (2) ensure
audit-gov's existing `pii.masked` event search reports zero events
since the M71 cutover, so the silent-regression nature of the gap is
documented in the audit trail.

---

## Follow-on (2026-07-20): the OUTBOUND prompt was never covered

The fix above closed the tool-output direction. It did not close the prompt.

`mask_pii_in_result` runs on tool output travelling *toward* the model
(`loop.py:868`) and `unmask_pii_in_args` runs on tool arguments travelling
*away* from it (`loop.py:708`, `loop.py:786`). The composed prompt itself —
system prompt, goal/task text, stage grounding, code context — went to the
provider verbatim. The operator-authored goal text is the single likeliest
place in the whole loop for a real SSN or a customer's email address, and it
was the one place with no mask at all.

`governed/outbound_pii.py` closes it. Read that module's docstring before
changing any of this; the short version:

**Narrow on purpose.** Three kinds only — `ssn`, `email`, `credit_card`
(Luhn-validated). `phone`, `zip9` and `ipv4` are deliberately EXCLUDED even
though `pii_mask.detect_pii` supports them. Source code is full of things
shaped like dotted quads and `NNNNN-NNNN`: version strings, byte offsets,
netmasks, port ranges, ids, test fixtures. Masking `192.168.1.1` out of a
config an agent was asked to debug does not over-redact a log — it produces a
**confident wrong answer that looks exactly like a right one**. That is
categorically different from a leaked secret, which is loud and findable. On
the egress path, prefer the leak you can see to the corruption you cannot.

This is the same reasoning that kept turn.py's generic
`(api_key|secret|password|token)` rule out of
`llm_gateway_service/app/secret_redaction.py`.

**The round trip is the hard part.** Tokens minted for the prompt must land in
the same `PhaseState.pii_token_map` the loop unmasks tool arguments against, or
a model that faithfully echoes `[EMAIL_1]` into a tool call sends the literal
string downstream. `turn.py` folds the returned map onto `state` before
`governed_step()`. Correspondingly, **shadow mode mints no tokens at all** —
allocating tokens the model never saw would make `unmask_pii_in_args` rewrite a
literal `[EMAIL_1]` that a user legitimately typed.

**Not covered:** the model's own prose. If the model writes `[EMAIL_1]` into a
phase output, it stays a token there. That is pre-existing (masked tool results
already put tokens in front of the model) and it is *visible* rather than
silent. Unmasking assistant prose is a separate change with its own risk: it
would rewrite tokens a user typed.

### Rollout

Off by default, and requires BOTH a mode and a named scope. An empty allowlist
matches nothing — leaving a mode set with no scope must not enable it fleet-wide.

| Env var | Values | Default |
|---|---|---|
| `CF_MASK_PROMPT_PII` | `off` \| `shadow` \| `enforce` | `off` |
| `CF_MASK_PROMPT_PII_CAPABILITIES` | comma-separated capability ids, or `*` | empty (matches nothing) |
| `CF_MASK_PROMPT_PII_TENANTS` | comma-separated tenant ids, or `*` | empty (matches nothing) |

`shadow` logs and audits what enforcing *would* mask and changes nothing —
prompt, token map and behaviour are all untouched. Measure there first; the
residual false positives are real and worth counting per capability before
enforcing:

- an email in a copyright header, an `AUTHORS` file or a `Co-Authored-By:`
  trailer is a real email and *will* be tokenised;
- a 16-digit numeric literal can pass Luhn by chance (~1 in 10 of those that
  match the shape at all).

Audit: `governed.prompt_pii_masked`, carrying kind + count only, plus
`prompt_modified` so an operator can tell "would have masked" from "did mask"
without inferring it from the mode string. Values are never recorded — a PII
audit record that quotes the PII is worse than no record.
