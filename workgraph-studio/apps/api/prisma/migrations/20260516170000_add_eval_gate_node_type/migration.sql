-- Add the Trust & Eval blocking workflow node type.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'EVAL_GATE';
