-- Direct LLM Task (v1): explicit WorkGraph-side LLM call that bypasses
-- Context Fabric and MCP. Intended for simple, server-executed agentic tasks
-- where the workflow stores only an env-var credential reference.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'DIRECT_LLM_TASK';
