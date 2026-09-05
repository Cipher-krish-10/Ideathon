import "server-only";

import type { EstimatorConfig } from "@/core/estimator";
import type { MerchantConfig } from "@/server/dataset/config";

/**
 * Estimator calibration.
 *
 * ------------------------------------------------------------------------
 * ASSUMPTION, stated plainly.
 *
 * ARCHITECTURE.md section 2 specifies the modifier chain:
 *
 *     p_recover = base_rate x recency x value_tier x incentive
 *
 * data/merchant_config.json supplies the BASE RATES (playbook_priors), the
 * gateway fee, discounts and channel costs -- but it contains NO modifier
 * tables. The dataset is approved and immutable, so the modifiers cannot be
 * added to it.
 *
 * They are therefore declared HERE, as versioned configuration, and passed into
 * the pure estimator as explicit input. src/core holds no policy of its own:
 * change these numbers and every estimate changes, with no code edit and no new
 * detector or estimator version.
 *
 * The values are plausible calibration constants, not measured effects. They
 * are starting beliefs in exactly the sense the seeded Beta priors are, and the
 * honest place to fix them is the LEARN step, from real outcomes. They should
 * move into merchant configuration proper whenever that file is next
 * regenerated.
 * ------------------------------------------------------------------------
 */

/**
 * Recency. A fresher failure converts better: the customer still remembers
 * wanting the thing. Bands are inclusive upper bounds, scanned in order.
 *
 * The detector already rejects failures older than the recency window, so the
 * final band is a floor for completeness rather than a case we expect to hit.
 */
const RECENCY_BANDS = [
  { maxDays: 3, modifierBps: 11_500 }, // x1.15 — still top of mind
  { maxDays: 7, modifierBps: 10_500 }, // x1.05
  { maxDays: 14, modifierBps: 10_000 }, // x1.00 — the reference band
  { maxDays: 30, modifierBps: 8_500 }, // x0.85 — interest cooling
  { maxDays: Number.MAX_SAFE_INTEGER, modifierBps: 7_000 }, // x0.70
] as const;

/** Customer tier. Established customers re-engage more readily. */
const TIER_MODIFIERS_BPS = {
  HIGH: 11_000, // x1.10
  MEDIUM: 10_000, // x1.00
  LOW: 9_000, // x0.90
} as const;

/**
 * Incentive, keyed on the discount ABOVE the playbook's own default.
 *
 * The priors are per (playbook, failure reason), so an offer playbook's base
 * rate already includes its standard discount. Bands therefore start at x1.0
 * and only lift when a merchant proposes something deeper than the default —
 * otherwise the incentive would be counted twice.
 */
const INCENTIVE_BANDS = [
  { maxDeltaBps: 0, modifierBps: 10_000 }, // at the default: no adjustment
  { maxDeltaBps: 500, modifierBps: 10_400 }, // up to +5pp
  { maxDeltaBps: 1_000, modifierBps: 10_800 }, // up to +10pp
  { maxDeltaBps: Number.MAX_SAFE_INTEGER, modifierBps: 11_100 }, // diminishing
] as const;

/**
 * Confidence thresholds.
 *
 * HIGH requires REAL recorded outcomes, not just a strong prior. The seeded
 * priors carry 40 pseudo-observations and zero real ones, so every estimate in
 * this build resolves to MEDIUM. That is the honest answer: a stated belief is
 * not evidence. HIGH becomes reachable once the LEARN step accumulates
 * outcomes, which is precisely the movement the demo should be able to show.
 */
const CONFIDENCE_THRESHOLDS = {
  highMinSampleSize: 100,
  mediumMinSampleSize: 30,
  highMinRealObservations: 30,
  highMinCompletenessBps: 10_000, // every target backed by a prior
  mediumMinCompletenessBps: 8_000, // at least 80%
} as const;

/**
 * Conservative rate used when no prior exists for a (playbook, failure reason).
 * Deliberately pessimistic: an unmodelled combination should not look
 * attractive, and it drags data completeness -- and therefore confidence -- down.
 */
const FALLBACK_BASE_RATE_BPS = 500; // 5%

/**
 * Build the estimator configuration.
 *
 * The gateway fee comes from merchant configuration; the modifier tables come
 * from the constants above until they have a home in merchant config.
 */
export function buildEstimatorConfig(merchantConfig: MerchantConfig): EstimatorConfig {
  return {
    recencyBands: RECENCY_BANDS,
    tierModifiersBps: TIER_MODIFIERS_BPS,
    defaultTierModifierBps: 10_000,
    incentiveBands: INCENTIVE_BANDS,
    gatewayFeeBps: merchantConfig.estimator_config.gateway_fee_bps,
    fallbackBaseRateBps: FALLBACK_BASE_RATE_BPS,
    confidence: CONFIDENCE_THRESHOLDS,
  };
}

export {
  CONFIDENCE_THRESHOLDS,
  FALLBACK_BASE_RATE_BPS,
  INCENTIVE_BANDS,
  RECENCY_BANDS,
  TIER_MODIFIERS_BPS,
};
