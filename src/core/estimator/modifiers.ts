/**
 * Fixed-point probability arithmetic and the modifier lookups.
 *
 * Probabilities and modifiers are basis points: 10000 means 1.0. Modifiers may
 * exceed 10000 (an uplift); a probability never may.
 *
 * Chained multiplication runs through BigInt with a single rounding at the end.
 * Rounding after each factor would make the result depend on the order the
 * factors were applied, which is exactly the kind of quiet irreproducibility
 * this product cannot afford.
 */
import type {
  ConfidenceLevel,
  ConfidenceThresholds,
  EstimatorConfig,
  IncentiveBand,
  PlaybookPrior,
  RecencyBand,
} from "./types";

export const BPS_ONE = 10_000;

/**
 * Multiply a base rate by any number of modifiers, all in bps.
 *
 * Exact until the final rounding (half-up), then clamped to a valid
 * probability. BigInt keeps the intermediate product exact no matter how many
 * factors are chained.
 */
export function chainBps(baseBps: number, ...modifiersBps: number[]): number {
  assertInteger(baseBps, "base rate");
  let numerator = BigInt(baseBps);
  let denominator = 1n;

  for (const modifier of modifiersBps) {
    assertInteger(modifier, "modifier");
    if (modifier < 0) throw new RangeError(`Modifier must be non-negative, got ${modifier}`);
    numerator *= BigInt(modifier);
    denominator *= BigInt(BPS_ONE);
  }

  // Round half-up on a single exact quotient.
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return clampProbabilityBps(Number(rounded));
}

/** Confine a value to a valid probability. */
export function clampProbabilityBps(bps: number): number {
  if (bps < 0) return 0;
  if (bps > BPS_ONE) return BPS_ONE;
  return bps;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer in basis points, got ${value}`);
  }
}

/**
 * Base recovery rate from a Beta prior: alpha / (alpha + beta), in bps.
 *
 * Counts are milli-units, so the ratio is scale-free and the division is exact
 * before a single half-up rounding.
 */
export function baseRateBpsFromPrior(prior: PlaybookPrior): number {
  const total = prior.alphaMilli + prior.betaMilli;
  if (total <= 0) return 0;
  const numerator = BigInt(prior.alphaMilli) * BigInt(BPS_ONE);
  const denominator = BigInt(total);
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return clampProbabilityBps(Number(rounded));
}

/** Pseudo-observations behind a prior, in whole units. */
export function priorSampleSize(prior: PlaybookPrior): number {
  return Math.round((prior.alphaMilli + prior.betaMilli) / 1000);
}

/**
 * Recency modifier. A fresher failure is likelier to convert: the customer
 * still remembers the purchase and the intent behind it.
 *
 * Bands are inclusive upper bounds, scanned in order; the last band is the
 * catch-all for anything older.
 */
export function recencyModifierBps(
  failureAgeDays: number,
  bands: readonly RecencyBand[],
): number {
  if (bands.length === 0) return BPS_ONE;
  for (const band of bands) {
    if (failureAgeDays <= band.maxDays) return band.modifierBps;
  }
  return bands[bands.length - 1]!.modifierBps;
}

/** Tier modifier. Unknown tiers fall back rather than throwing. */
export function tierModifierBps(tier: string, config: EstimatorConfig): number {
  return config.tierModifiersBps[tier] ?? config.defaultTierModifierBps;
}

/**
 * Incentive modifier, keyed on the discount ABOVE the playbook's default.
 *
 * This is deliberately a DELTA, not the absolute discount. The Beta priors are
 * stored per (playbook, failure reason), so PAYMENT_LINK_WITH_OFFER's base rate
 * already reflects its standard 10% offer. Multiplying by an absolute-discount
 * modifier on top would count that incentive twice and inflate every offer
 * estimate. At the configured default the modifier is exactly x1.0, and it only
 * moves when a merchant proposes a deeper discount than the playbook's own.
 */
export function incentiveModifierBps(
  discountBps: number,
  defaultDiscountBps: number,
  bands: readonly IncentiveBand[],
): number {
  if (bands.length === 0) return BPS_ONE;
  const deltaBps = discountBps - defaultDiscountBps;
  // A discount below the playbook default earns no uplift; it is not modelled
  // as a penalty, because no prior supports that claim.
  if (deltaBps <= 0) return BPS_ONE;
  for (const band of bands) {
    if (deltaBps <= band.maxDeltaBps) return band.modifierBps;
  }
  return bands[bands.length - 1]!.modifierBps;
}

export interface ConfidenceInputs {
  /** Weakest prior across all targets — confidence follows the weakest link. */
  minPriorSampleSize: number;
  totalRealObservations: number;
  /** Share of targets backed by a real prior, in bps. */
  dataCompletenessBps: number;
}

/**
 * confidence = f(priorSampleSize, dataCompleteness)
 *
 * HIGH additionally requires REAL recorded outcomes. Seeded priors are stated
 * beliefs, not evidence: claiming high confidence on zero observations would be
 * the estimator asserting something it has not earned. Once the LEARN step
 * accumulates outcomes, HIGH becomes reachable and the movement is visible.
 */
export function resolveConfidence(
  inputs: ConfidenceInputs,
  thresholds: ConfidenceThresholds,
): ConfidenceLevel {
  const { minPriorSampleSize, totalRealObservations, dataCompletenessBps } = inputs;

  if (
    minPriorSampleSize >= thresholds.highMinSampleSize &&
    totalRealObservations >= thresholds.highMinRealObservations &&
    dataCompletenessBps >= thresholds.highMinCompletenessBps
  ) {
    return "HIGH";
  }

  if (
    minPriorSampleSize >= thresholds.mediumMinSampleSize &&
    dataCompletenessBps >= thresholds.mediumMinCompletenessBps
  ) {
    return "MEDIUM";
  }

  return "LOW";
}
