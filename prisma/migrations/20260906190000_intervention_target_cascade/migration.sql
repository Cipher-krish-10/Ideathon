-- InterventionTarget foreign keys: RESTRICT -> CASCADE.
--
-- The same latent defect fixed for opportunity_target in Phase 1, now reached
-- because the reasoner populates intervention_target. RESTRICT made a merchant
-- permanently undeletable the moment a proposal existed: the cascade from
-- merchant reached `customer` while a target still referenced it.
--
-- A target is derived data the agent can recompute. The durable record of what
-- was decided is the append-only, hash-chained audit_log.
ALTER TABLE "intervention_target"
  DROP CONSTRAINT "intervention_target_customerId_fkey",
  ADD CONSTRAINT "intervention_target_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intervention_target"
  DROP CONSTRAINT "intervention_target_transactionId_fkey",
  ADD CONSTRAINT "intervention_target_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transaction"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
