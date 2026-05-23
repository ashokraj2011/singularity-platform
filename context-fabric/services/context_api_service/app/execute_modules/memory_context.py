"""
M73 — conversation memory.

TODO(M73-followup): extract from execute.py:920..1849.

Owns interaction with the context-memory service (compile / persist /
summarise). Today these calls are scattered:

  build_history(session_id, agent_id, user_message, ...) → (history, msg, sys, opt, warnings)
      Wraps prompt_context.compile_execute_context for the orchestrator.
      Currently called inline at execute.py:~1300.

  persist_turn(session_id, role, content, model_call_id) → None
      POSTs to context-memory's /conversations/{session_id}/turns.
      Called after a successful LLM response to grow the conversation
      history that the next call's compile_execute_context will reference.
      Currently inline at execute.py:~1700-1750.

  maybe_summarise(session_id, history_length) → None
      Triggers context-memory's /summarize when the conversation hits
      a configurable threshold (default 20 turns or 8k chars). Lets the
      next compile call replace early turns with a single summary
      message, keeping prompt size bounded.
      Currently inline at execute.py:~1750-1780.

The compile half is already extracted (prompt_context.compile_execute_context)
because it's a pure function with no execute-body coupling. The persist
+ summarise paths read mcp invoke results AND mutate a session id that's
constructed mid-execute(), so they need orchestrator restructuring first.
"""
from __future__ import annotations
