-- Create Work Branch (v1): add CREATE_BRANCH to the NodeType enum.
-- IF NOT EXISTS keeps it idempotent; mirrors 20260707120000_add_raise_pr_node_type.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'CREATE_BRANCH';
