-- Demo simulation clock.
--
-- Presentation only. No detector, estimator, guardrail or attribution logic
-- reads this table: those judge against the dataset's own reference instant,
-- which is what keeps their results reproducible. This exists purely so the
-- demo can show a merchant environment moving forward rather than a static
-- historical dashboard.
CREATE TABLE "simulation_state" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "baselineAt" TIMESTAMP(3) NOT NULL,
    "simulatedNow" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "advancedMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "simulation_state_merchantId_key" ON "simulation_state"("merchantId");

ALTER TABLE "simulation_state" ADD CONSTRAINT "simulation_state_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "simulation_state"
  ADD CONSTRAINT "simulation_state_advanced_non_negative" CHECK ("advancedMinutes" >= 0),
  -- The clock may only move forward from its baseline.
  ADD CONSTRAINT "simulation_state_not_before_baseline" CHECK ("simulatedNow" >= "baselineAt");
