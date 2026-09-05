-- RevenuePilot integrity layer.
--
-- Everything here enforces, in the database, an invariant the product claims in
-- ARCHITECTURE.md. Application code can be bypassed; these cannot.
--
--   1. Money is a positive integer number of paise.
--   2. A FAILED attempt has a reason; a SUCCESS attempt has none.
--   3. No intervention may reach an execution state without an APPROVED approval.
--   4. No execution attempt may exist without an APPROVED approval.
--   5. The audit log is append-only.

-- ---------------------------------------------------------------------------
-- 1. Money and cardinality CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE "product"
  ADD CONSTRAINT "product_price_positive" CHECK ("pricePaise" > 0);

ALTER TABLE "customer"
  ADD CONSTRAINT "customer_values_non_negative"
    CHECK ("lifetimeValuePaise" >= 0 AND "historicalValuePaise" >= 0),
  ADD CONSTRAINT "customer_lifetime_covers_historical"
    CHECK ("lifetimeValuePaise" >= "historicalValuePaise"),
  -- A suppression date and its reason travel together, in both directions.
  ADD CONSTRAINT "customer_suppression_paired"
    CHECK (("doNotContactUntil" IS NULL) = ("suppressionReason" IS NULL));

ALTER TABLE "transaction"
  ADD CONSTRAINT "transaction_amount_positive" CHECK ("amountPaise" > 0),
  ADD CONSTRAINT "transaction_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "transaction_attempt_count_positive" CHECK ("attemptCount" > 0),
  -- refundedAt is present exactly when the transaction is REFUNDED.
  ADD CONSTRAINT "transaction_refund_consistency"
    CHECK (("status" = 'REFUNDED') = ("refundedAt" IS NOT NULL));

ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_amount_positive" CHECK ("amountPaise" > 0),
  ADD CONSTRAINT "payment_attempt_no_positive" CHECK ("attemptNo" >= 1),
  -- 2. A failure has a reason; a success does not.
  ADD CONSTRAINT "payment_attempt_reason_matches_status"
    CHECK (
      ("status" = 'FAILED'  AND "failureReason" IS NOT NULL) OR
      ("status" <> 'FAILED' AND "failureReason" IS NULL)
    ),
  -- The first attempt in a chain has no parent; later ones must have one.
  ADD CONSTRAINT "payment_attempt_retry_link_matches_no"
    CHECK (
      ("attemptNo" = 1 AND "retryOfAttemptId" IS NULL) OR
      ("attemptNo" > 1 AND "retryOfAttemptId" IS NOT NULL)
    ),
  -- An attempt may never be its own retry parent.
  ADD CONSTRAINT "payment_attempt_no_self_retry"
    CHECK ("retryOfAttemptId" IS NULL OR "retryOfAttemptId" <> "id");

ALTER TABLE "opportunity"
  ADD CONSTRAINT "opportunity_amounts_non_negative"
    CHECK ("recoverableAmountPaise" >= 0 AND "affectedCustomerCount" >= 0);

ALTER TABLE "opportunity_target"
  ADD CONSTRAINT "opportunity_target_amount_positive"
    CHECK ("recoverableAmountPaise" > 0);

ALTER TABLE "playbook"
  ADD CONSTRAINT "playbook_discount_bps_range"
    CHECK ("defaultDiscountBps" >= 0 AND "defaultDiscountBps" <= 10000),
  ADD CONSTRAINT "playbook_channel_cost_non_negative"
    CHECK ("channelCostPaise" >= 0);

ALTER TABLE "estimate"
  -- expectedNetPaise may legitimately be negative; MIN_EXPECTED_NET blocks those
  -- at the guardrail layer rather than here.
  ADD CONSTRAINT "estimate_gross_non_negative" CHECK ("expectedGrossPaise" >= 0),
  ADD CONSTRAINT "estimate_costs_non_negative"
    CHECK ("costPaise" >= 0 AND "discountCostPaise" >= 0
       AND "channelCostPaise" >= 0 AND "gatewayFeePaise" >= 0),
  ADD CONSTRAINT "estimate_net_is_gross_minus_cost"
    CHECK ("expectedNetPaise" = "expectedGrossPaise" - "costPaise"),
  ADD CONSTRAINT "estimate_cost_components_sum"
    CHECK ("costPaise" = "discountCostPaise" + "channelCostPaise" + "gatewayFeePaise"),
  -- Probability lives in basis points, never as a float.
  ADD CONSTRAINT "estimate_p_recover_bps_range"
    CHECK ("pRecoverAvgBps" >= 0 AND "pRecoverAvgBps" <= 10000);

ALTER TABLE "intervention_target"
  ADD CONSTRAINT "intervention_target_amount_positive" CHECK ("amountPaise" > 0);

ALTER TABLE "intervention"
  ADD CONSTRAINT "intervention_version_non_negative" CHECK ("version" >= 0);

ALTER TABLE "execution_attempt"
  ADD CONSTRAINT "execution_attempt_no_positive" CHECK ("attemptNo" >= 1);

ALTER TABLE "razorpay_artifact"
  ADD CONSTRAINT "razorpay_artifact_amount_positive" CHECK ("amountPaise" > 0);

ALTER TABLE "attribution_record"
  ADD CONSTRAINT "attribution_amount_positive" CHECK ("attributedAmountPaise" > 0);

ALTER TABLE "playbook_stat"
  ADD CONSTRAINT "playbook_stat_counts_positive"
    CHECK ("alphaMilli" > 0 AND "betaMilli" > 0
       AND "seededAlphaMilli" > 0 AND "seededBetaMilli" > 0),
  ADD CONSTRAINT "playbook_stat_observations_non_negative"
    CHECK ("observationCount" >= 0);

ALTER TABLE "guardrail_policy"
  ADD CONSTRAINT "guardrail_policy_version_positive" CHECK ("version" >= 1);

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_seq_positive" CHECK ("seq" >= 1),
  ADD CONSTRAINT "audit_log_hash_shape"
    CHECK (char_length("hash") = 64 AND char_length("prevHash") = 64);

-- ---------------------------------------------------------------------------
-- 3. Approval gate: an intervention may not reach an execution state without a
--    recorded APPROVED decision.
--
--    This is the central safety promise of the product. It is enforced here so
--    that no code path -- agent, API, script, or manual SQL -- can bypass it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION revenuepilot_require_approval_for_execution()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" IN (
    'EXECUTING', 'EXECUTED', 'EXECUTION_FAILED',
    'OBSERVING', 'CONVERTED', 'NOT_CONVERTED', 'LEARNED'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM "approval"
       WHERE "interventionId" = NEW."id"
         AND "decision" = 'APPROVED'
    ) THEN
      RAISE EXCEPTION
        'intervention % cannot enter state % without an APPROVED approval',
        NEW."id", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "intervention_require_approval"
  BEFORE INSERT OR UPDATE OF "state" ON "intervention"
  FOR EACH ROW EXECUTE FUNCTION revenuepilot_require_approval_for_execution();

-- 4. The same gate on the executor's own table: no provider call may be
--    recorded for an intervention that was never approved.

CREATE OR REPLACE FUNCTION revenuepilot_require_approval_for_attempt()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "approval"
     WHERE "interventionId" = NEW."interventionId"
       AND "decision" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION
      'execution attempt for intervention % requires an APPROVED approval',
      NEW."interventionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "execution_attempt_require_approval"
  BEFORE INSERT ON "execution_attempt"
  FOR EACH ROW EXECUTE FUNCTION revenuepilot_require_approval_for_attempt();

-- ---------------------------------------------------------------------------
-- 5. Append-only audit log.
--
--    UPDATE is rejected unconditionally: an audit row is never editable.
--    DELETE is rejected unless a session explicitly opts in, which is what
--    makes demo teardown possible without weakening the guarantee:
--        SET LOCAL revenuepilot.allow_audit_purge = 'on';
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION revenuepilot_audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('revenuepilot.allow_audit_purge', true), 'off') <> 'on' THEN
      RAISE EXCEPTION
        'audit_log is append-only: DELETE requires revenuepilot.allow_audit_purge'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION revenuepilot_audit_log_append_only();
