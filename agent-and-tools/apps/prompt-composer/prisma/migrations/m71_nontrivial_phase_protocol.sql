-- task #112 — Append governed-loop phase-output protocol to non-coding
-- stage prompts (PRODUCT_OWNER intake, default ARCHITECT/etc fallback).
--
-- Why this is needed: M71 Slice C wired all blueprint stages through
-- runCodingStageGoverned, which expects the LLM to either dispatch a
-- tool or call the synthetic `submit_phase_output` meta-tool to
-- advance the phase machine. Coding stages got phase-specific prompts
-- in Slice E (Developer/QA PLAN/EXPLORE/ACT/...) but the non-coding
-- prompts (PRODUCT_OWNER intake + the generic default that ARCHITECT
-- falls back to) still asked for Markdown prose. Result: every
-- attempt looped to max_turns and returned FAILED because the LLM
-- never signalled phase completion.
--
-- Companion change: context-fabric/services/context_api_service/app/
-- governed/phase_state.py adds PLAN → SELF_REVIEW to the allowed
-- transitions, since the PRODUCT_OWNER StagePolicy only defines
-- those two phases (no EXPLORE/ACT/VERIFY) and the canonical
-- 5-step path was unreachable.
--
-- Idempotent: ONLY appends the protocol section when it isn't
-- already present, so a re-run is a no-op.

UPDATE "PromptProfile"
SET "taskTemplate" = "taskTemplate" || E'\n\n## Phase protocol (governed loop)\n\nThis stage runs under a phase machine that requires you to signal completion via a tool call. After you have prepared the response described above, you MUST call the synthetic `submit_phase_output` tool to advance.\n\n- For the **PLAN** phase, call:\n  `submit_phase_output({ payload: { story_brief: "<markdown narrative>", acceptance_criteria: ["<criterion 1>", "<criterion 2>", ...], open_questions: ["<question 1>", ...] }, next_phase: "SELF_REVIEW" })`\n\n- For the **SELF_REVIEW** phase, call:\n  `submit_phase_output({ payload: { recommended_for_approval: true|false, risk_summary: { ... } }, next_phase: "FINALIZE" })`\n\nThe `payload.story_brief` field carries your Markdown narrative — put the full story brief, acceptance contract, in-scope/out-of-scope notes, assumptions, and risks there. The `acceptance_criteria` array carries the discrete pass/fail conditions. Do NOT emit prose without also calling `submit_phase_output`; the prose alone cannot advance the stage.',
    "updatedAt" = NOW()
WHERE id = '00000000-0000-0000-0000-0000000000f7'
  AND "taskTemplate" NOT LIKE '%submit_phase_output%';

UPDATE "PromptProfile"
SET "taskTemplate" = "taskTemplate" || E'\n\n## Phase protocol (governed loop)\n\nThis stage runs under a phase machine that requires you to signal completion via a tool call. After you have prepared the response described above, you MUST call the synthetic `submit_phase_output` tool to advance.\n\n- For the **PLAN** phase, call:\n  `submit_phase_output({ payload: { /* phase-specific receipt — see your stage policy */ }, next_phase: "SELF_REVIEW" })`\n\n- For the **SELF_REVIEW** phase, call:\n  `submit_phase_output({ payload: { recommended_for_approval: true|false, risk_summary: { ... } }, next_phase: "FINALIZE" })`\n\nDo NOT emit prose without also calling `submit_phase_output`; the prose alone cannot advance the stage.',
    "updatedAt" = NOW()
WHERE id = '00000000-0000-0000-0000-0000000000f4'
  AND "taskTemplate" NOT LIKE '%submit_phase_output%';
