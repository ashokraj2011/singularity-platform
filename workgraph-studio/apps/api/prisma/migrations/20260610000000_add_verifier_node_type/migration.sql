-- Add the VERIFIER workflow node type (a stage that runs the verifier agent on
-- the prior stage's produced documents and blocks the run on a standards failure).
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'VERIFIER';
