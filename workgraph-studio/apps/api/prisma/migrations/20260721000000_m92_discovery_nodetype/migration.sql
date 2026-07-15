-- M92: Add DISCOVERY to the NodeType enum (ADR 0006 Slice 4) — a workflow node
-- that runs a DiscoverySession and parks while blocking questions stay OPEN.

DO $$ BEGIN
    ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'DISCOVERY';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
