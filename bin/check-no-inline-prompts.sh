#!/usr/bin/env bash
# M36.7 — CI guard for the "no inline prompts" invariant.
#
# Enforces that LLM-bound prompt content lives in prompt-composer's DB
# (PromptProfile, StagePromptBinding, SystemPrompt, EventHorizonAction —
# all seeded by agent-and-tools/apps/prompt-composer/prisma/seed.ts), NOT
# inline in service TypeScript source.
#
# The pattern matching is intentionally narrow to keep false-positive
# noise low. We look for:
#   1. "You are the X agent" / "You are X" assistant-prefixed system prompts
#   2. Multi-line system_prompt: [...] arrays passed to LLM clients
#   3. systemPrompt: ` and `systemPrompt: "` literals in *.ts (not in seeds/tests)
#   4. Hardcoded MCP tool-name literals in business logic (write_file,
#      apply_patch, git_commit, finish_work_branch, etc.) appearing OUTSIDE
#      the tool-registration files themselves.
#
# Allowed locations (whitelist):
#   - agent-and-tools/apps/prompt-composer/prisma/seed.ts            (the source of truth)
#   - agent-runtime/prisma/seed.ts                                   (role-contract seeds)
#   - mcp-server/src/tools/                                          (tool descriptors)
#   - mcp-server/src/llm/mock.ts                                     (test mock provider)
#   - mcp-server/src/audit/provenanceExtractor.ts                    (parses tool names from invocations — needs to know the catalog)
#   - mcp-server/src/lib/governance-policy.ts                        (risk-tier policy table — separate from prompts)
#   - mcp-server/src/mcp/invoke.ts (hasTool helper)                  (governance detection, not prompt content)
#   - mcp-server/src/mcp/tools.ts                                    (deprecated sync tool-call endpoint, env-gated in prod)
#   - mcp-server/src/mcp/work.ts                                     (M37.1 purpose-built work-branch endpoint)
#   - agent-and-tools/apps/tool-service/src/lib/seed-core-tools.ts   (tool catalog seed)
#   - **/*.test.ts / **/*.contract.test.ts                           (tests)
#   - bin/                                                            (scripts, incl. this guard)
#   - docs/                                                           (docs)
#   - .singularity/                                                   (operator config)
#
# M37.1 — GitPushExecutor.ts is no longer whitelisted: it uses the
# purpose-built /mcp/work/finish-branch endpoint and carries no tool-name
# literal in caller TS. If a regression re-introduces a hardcoded name,
# the guard catches it.
#
# Exit 0 → clean. Exit non-zero → at least one new inline-prompt regression.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }

EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=dist
  --exclude-dir=generated
  --exclude-dir=.next
  --exclude-dir=__pycache__
  --exclude-dir=.venv
  --exclude-dir=build
)

# Whitelist: files where prompt content is *expected* to live. A match is
# allowed if its path matches any of these patterns.
ALLOW_RE='(prompt-composer/prisma/seed\.ts|agent-runtime/prisma/seed\.ts|mcp-server/src/tools/|mcp-server/src/llm/mock\.ts|mcp-server/src/audit/provenanceExtractor\.ts|mcp-server/src/lib/governance-policy\.ts|mcp-server/src/mcp/invoke\.ts|mcp-server/src/mcp/tools\.ts|mcp-server/src/mcp/work\.ts|tool-service/src/lib/seed-core-tools\.ts|audit-governance-service/src/engine/extract-lesson\.ts|\.test\.ts$|\.contract\.test\.ts$|/bin/|/docs/|/\.singularity/|/scripts/|/tests/|/test/|/prisma/seed)'

# Filter grep output through the allow-list. Lines whose file path matches
# the allow regex are removed; the rest are real violations.
filter_allowlist() {
  awk -F: -v allow="$ALLOW_RE" '
    {
      # First field is the filename. Skip if it matches the allow list.
      if ($1 ~ allow) next
      print
    }
  '
}

EXIT_CODE=0

# ─── Check 1: "You are the X agent" / "You are X" assistant prefixes ───────
# Skip lines where the match is a UI placeholder= attribute (those are form
# hints, not LLM-bound prompts).
header '1. "You are the X agent" system prompts in TS/TSX/JS'
HITS=$(grep -rnE 'You are (the |an? )?[A-Z][A-Za-z _]+( agent| Agent)' \
  "${EXCLUDE_DIRS[@]}" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  . 2>/dev/null \
  | grep -vE 'placeholder=' \
  | filter_allowlist || true)
if [ -n "$HITS" ]; then
  red "FAIL: hardcoded \"You are the X agent\" prompts found outside the allowlist."
  red "  Move the text to PromptLayer / SystemPrompt / StagePromptBinding."
  red ""
  echo "$HITS" | sed 's/^/  /' >&2
  EXIT_CODE=1
else
  green 'OK: no "You are the X agent" prompts inline.'
fi

# ─── Check 2: multi-line system_prompt arrays passed to LLM clients ────────
header '2. multi-line system_prompt: [...] literals passed to LLM execute calls'
HITS=$(grep -rnE 'system_?[Pp]rompt:[[:space:]]*\[' \
  "${EXCLUDE_DIRS[@]}" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  . 2>/dev/null | filter_allowlist || true)
if [ -n "$HITS" ]; then
  red 'FAIL: inline system_prompt: [...] arrays found outside the allowlist.'
  red "  Replace with promptComposerClient.getSystemPrompt(...) or .resolveStage(...)."
  red ""
  echo "$HITS" | sed 's/^/  /' >&2
  EXIT_CODE=1
else
  green 'OK: no inline system_prompt: [...] arrays.'
fi

# ─── Check 3: `const SYSTEM_PROMPT = backtick-string with prompt-y content ─
header '3. const SYSTEM_PROMPT = `...` literal prompts at module scope'
HITS=$(grep -rnE '^[[:space:]]*const[[:space:]]+[A-Z_]*SYSTEM_PROMPT[A-Z_]*[[:space:]]*=[[:space:]]*`' \
  "${EXCLUDE_DIRS[@]}" \
  --include='*.ts' --include='*.tsx' \
  . 2>/dev/null | filter_allowlist || true)
if [ -n "$HITS" ]; then
  red 'FAIL: top-level SYSTEM_PROMPT literals outside the allowlist.'
  red "  These belong in the SystemPrompt table; fetch with getSystemPrompt()."
  red ""
  echo "$HITS" | sed 's/^/  /' >&2
  EXIT_CODE=1
else
  green 'OK: no top-level SYSTEM_PROMPT constants.'
fi

# ─── Check 4: hardcoded MCP tool-name literals in business logic ───────────
# We allow these only in: tool registration files, prompt-composer seed
# (where the policy layer mentions them by name), tests, and the guard
# itself. Anywhere else, the tool name should come from the LLM's tool_call
# decision, not be hardcoded in dispatch logic.
header '4. hardcoded MCP tool-name literals in business logic'
TOOL_NAMES='write_file|apply_patch|git_commit|finish_work_branch|prepare_work_branch'
# Allow this guard's whitelist + this very file
EXTRA_ALLOW='(check-no-inline-prompts\.sh)'
HITS=$(grep -rnE "[\"']($TOOL_NAMES)[\"']" \
  "${EXCLUDE_DIRS[@]}" \
  --include='*.ts' --include='*.tsx' --include='*.js' \
  . 2>/dev/null \
  | awk -F: -v allow="$ALLOW_RE" -v extra="$EXTRA_ALLOW" '
      {
        if ($1 ~ allow) next
        if ($1 ~ extra) next
        print
      }
    ' || true)
if [ -n "$HITS" ]; then
  red 'FAIL: hardcoded MCP tool-name literals found in business logic.'
  red "  Tool selection should come from the LLM tool_call, not from string literals in TS."
  red "  If you need to mention the tool name in a prompt, put it in a PromptLayer (TOOL_CONTRACT)."
  red ""
  echo "$HITS" | sed 's/^/  /' >&2
  EXIT_CODE=1
else
  green 'OK: no hardcoded MCP tool names in business logic.'
fi

header 'Summary'
if [ $EXIT_CODE -eq 0 ]; then
  green '✅ No inline-prompt regressions detected.'
  green '   Prompts live in singularity_composer DB. CI gate passes.'
else
  red '❌ Inline-prompt regressions detected (see FAIL blocks above).'
  red ''
  red '   How to fix:'
  red '   1. Add the prompt text to agent-and-tools/apps/prompt-composer/prisma/seed.ts'
  red '      (in SYSTEM_PROMPTS, EVENT_HORIZON_ACTIONS, or as a PromptLayer/StagePromptBinding row).'
  red '   2. Replace the inline literal with a call to:'
  red '       - promptComposerClient.getSystemPrompt(key)        for single-shot prompts'
  red '       - promptComposerClient.resolveStage({stageKey,..}) for staged agent prompts'
  red '       - GET /api/v1/event-horizon-actions?surface=...    for SPA quick actions'
  red '   3. Re-seed prompt-composer: cd agent-and-tools/apps/prompt-composer && npm run prisma:seed'
fi

exit $EXIT_CODE
