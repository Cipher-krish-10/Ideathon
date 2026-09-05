-- Estimate idempotency becomes version-aware.
--
-- The old key was (opportunityId, playbookId), which meant a new estimator
-- version could not score an opportunity that an older version had already
-- scored. Estimates are the audit trail behind a money decision: a new version
-- must be able to score alongside the old one, so an Intervention stays
-- explainable by the exact version that produced its numbers.
DROP INDEX "estimate_opportunityId_playbookId_key";

CREATE UNIQUE INDEX "estimate_opportunityId_playbookId_estimatorVersion_key"
  ON "estimate" ("opportunityId", "playbookId", "estimatorVersion");
