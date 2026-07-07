-- Raise Pull Request (v1): add RAISE_PR to the NodeType enum.
-- IF NOT EXISTS keeps it idempotent; mirrors 20260628000000_add_governance_gate_node_type.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'RAISE_PR';
