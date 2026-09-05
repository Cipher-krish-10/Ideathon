/**
 * Typed reader for data/merchant_config.json.
 *
 * Validated with Zod at load time: the seed and the future detector both depend
 * on this file's shape, and a silent structural drift would surface much later
 * as a wrong number on a demo screen.
 */
import { z } from "zod";

export const merchantConfigSchema = z.object({
  schema_version: z.string(),
  merchant: z.object({
    merchant_id: z.string(),
    name: z.string(),
    business_type: z.string(),
    timezone: z.string(),
    currency: z.string(),
    mode: z.enum(["TEST", "LIVE"]),
  }),
  dataset: z.object({
    generator_version: z.string(),
    seed: z.number().int(),
    reference_date: z.string(),
    reference_datetime: z.string(),
    window_start_date: z.string(),
    window_days: z.number().int(),
  }),
  detector_config: z.object({
    detector_key: z.string(),
    detector_version: z.string(),
    recoverable_failure_reasons: z.array(z.string()),
    non_recoverable_failure_reasons: z.array(z.string()),
    recency_window_days: z.number().int(),
    min_transaction_amount_paise: z.number().int(),
    min_customer_lifetime_value_paise: z.number().int(),
  }),
  customer_tiers: z.record(
    z.string(),
    z.object({ min_lifetime_value_paise: z.number().int() }),
  ),
  guardrail_policy: z.object({
    policy_version: z.number().int(),
    rules: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
  playbooks: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      action_type: z.string(),
      default_discount_bps: z.number().int(),
      channel_cost_paise: z.number().int(),
    }),
  ),
  playbook_priors: z.array(
    z.object({
      playbook_key: z.string(),
      failure_reason: z.string(),
      alpha: z.number(),
      beta: z.number(),
      implied_base_rate: z.number(),
    }),
  ),
  estimator_config: z.object({
    gateway_fee_bps: z.number().int(),
    attribution_window_days: z.number().int(),
  }),
});

export type MerchantConfig = z.infer<typeof merchantConfigSchema>;

export const datasetSummarySchema = z.object({
  generated_with: z.object({
    generator_version: z.string(),
    seed: z.number().int(),
    reference_date: z.string(),
    window_start_date: z.string(),
  }),
  row_counts: z.object({
    customers: z.number().int(),
    products: z.number().int(),
    transactions: z.number().int(),
    payment_attempts: z.number().int(),
    failed_payment_attempts: z.number().int(),
    successful_payment_attempts: z.number().int(),
  }),
  money_paise: z.object({
    total_transaction_value: z.number().int(),
    captured_revenue: z.number().int(),
    refunded_value: z.number().int(),
    failed_payment_value: z.number().int(),
  }),
  customers: z.object({
    total: z.number().int(),
    with_failed_payment: z.number().int(),
    actively_suppressed: z.number().int(),
    expired_suppression: z.number().int(),
    tier_distribution: z.record(z.string(), z.number().int()),
  }),
  transactions: z.object({
    status_distribution: z.record(z.string(), z.number().int()),
    multi_attempt_transactions: z.number().int(),
  }),
  failure_reason_distribution: z.record(z.string(), z.number().int()),
});

export type DatasetSummary = z.infer<typeof datasetSummarySchema>;

/**
 * Beta priors are decimals in JSON (e.g. 18.8) but are stored as MILLI-units
 * so the LEARN step updates integers and stays exactly reproducible.
 */
export function toMilli(value: number): number {
  const scaled = Math.round(value * 1000);
  if (Math.abs(value * 1000 - scaled) > 1e-6) {
    throw new Error(`${value} has more precision than milli-units can represent`);
  }
  return scaled;
}
