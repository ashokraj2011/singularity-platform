-- P1-12 durable signals.
-- An emitted signal is persisted so a SIGNAL_WAIT node that parks AFTER the emit
-- can still consume it (fixes emit-before-wait loss). Instance-scoped; windowed
-- via expiresAt; consumedAt is an atomic single-winner claim.

CREATE TABLE "workflow_signals" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "signalName" TEXT NOT NULL,
    "correlationKey" TEXT,
    "payload" JSONB,
    "emittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_signals_pkey" PRIMARY KEY ("id")
);

-- Consume lookup: pending (consumedAt IS NULL) signals for a waiter in an instance.
CREATE INDEX "workflow_signals_instanceId_signalName_consumedAt_idx" ON "workflow_signals"("instanceId", "signalName", "consumedAt");

-- For expiry cleanup of stale signals.
CREATE INDEX "workflow_signals_expiresAt_idx" ON "workflow_signals"("expiresAt");
