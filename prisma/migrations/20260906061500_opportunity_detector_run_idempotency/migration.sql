-- Detector-run idempotency.
--
-- Re-running the same detector version against the same reference instant must
-- reuse one Opportunity row, never create a second. Enforcing it here rather
-- than in the service means a concurrent double-run conflicts loudly instead of
-- quietly duplicating an opportunity and double-counting recoverable revenue.
CREATE UNIQUE INDEX "opportunity_merchantId_detectorKey_detectorVersion_referenceAt_key"
  ON "opportunity" ("merchantId", "detectorKey", "detectorVersion", "referenceAt");
