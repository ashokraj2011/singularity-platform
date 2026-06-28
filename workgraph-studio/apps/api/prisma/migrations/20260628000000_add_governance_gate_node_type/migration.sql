-- Capability Governance Gate (v1): add GOVERNANCE_GATE to the NodeType enum.
-- IF NOT EXISTS keeps it idempotent; mirrors 20260610000000_add_verifier_node_type.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_GATE';
