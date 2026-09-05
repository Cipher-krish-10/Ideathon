-- OpportunityTarget foreign keys: RESTRICT -> CASCADE.
--
-- A target is DERIVED data: a pointer into source records that the detector can
-- recompute from scratch at any time. RESTRICT made a merchant permanently
-- undeletable the moment a detector run produced targets, because the cascade
-- from merchant reached `customer` while a target still referenced it.
--
-- That was not a guarantee worth keeping. The durable record of what the agent
-- decided is the append-only, hash-chained audit_log -- not this table.
ALTER TABLE "opportunity_target"
  DROP CONSTRAINT "opportunity_target_customerId_fkey",
  ADD CONSTRAINT "opportunity_target_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "opportunity_target"
  DROP CONSTRAINT "opportunity_target_transactionId_fkey",
  ADD CONSTRAINT "opportunity_target_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transaction"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "opportunity_target"
  DROP CONSTRAINT "opportunity_target_paymentAttemptId_fkey",
  ADD CONSTRAINT "opportunity_target_paymentAttemptId_fkey"
    FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
