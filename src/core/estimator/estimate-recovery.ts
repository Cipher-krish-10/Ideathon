/**
 * Deterministic estimator for failed-payment recovery.
 *
 * Scores EVERY eligible playbook against a detected opportunity. It does not
 * choose. Ranking is the reasoner's job in a later phase, with a deterministic
 * argmax(expectedNetPaise) fallback that deliberately lives outside this module
 * — an estimator that picked a winner would make "the LLM only chose among
 * pre-scored options" untrue the moment the LLM agreed with it.
 *
 * FORMULA (ARCHITECTURE.md section 2), all in fixed point:
 *
 *   p_recover(target, playbook)
 *       = base_rate(playbook, failureReason)     <- Beta prior from PlaybookStat
 *       x recency_modifier(failureAgeDays)
 *       x value_tier_modifier(customerTier)
 *       x incentive_modifier(discountBps - defaultDiscountBps)
 *
 *   per target:
 *     expectedGross_i = amount_i          x p_recover_i
 *     discountCost_i  = expectedGross_i   x discountBps
 *     collected_i     = expectedGross_i   - discountCost_i
 *     gatewayFee_i    = collected_i       x gatewayFeeBps
 *
 *   aggregate:
 *     expectedGrossPaise = SUM(expectedGross_i)
 *     costPaise          = SUM(discountCost_i) + channelCost x targets + SUM(gatewayFee_i)
 *     expectedNetPaise   = expectedGrossPaise - costPaise
 *
 * Discount and gateway fee scale with EXPECTED RECOVERED revenue, not with the
 * full book: a discount is only conceded on a payment that actually arrives,
 * and a gateway fee is only charged on money actually collected.
 *
 * No float, no clock, no I/O, no randomness. Inputs are never mutated.
 */
import { applyBps } from "@/lib/money";

import {
  BPS_ONE,
  baseRateBpsFromPrior,
  chainBps,
  incentiveModifierBps,
  priorSampleSize,
  recencyModifierBps,
  resolveConfidence,
  tierModifierBps,
} from "./modifiers";
import type {
  EstimateCandidate,
  EstimatorInput,
  EstimatorPlaybook,
  PlaybookPrior,
  TargetBreakdown,
} from "./types";

/**
 * Version of the scoring rules. Persisted on every Estimate.
 * Changing any formula, modifier semantic, or rounding rule REQUIRES a bump:
 * a stored estimate must stay explainable by the version that produced it.
 */
export const ESTIMATOR_VERSION = "failed-payment-recovery-estimator:v1";

/** Key for the prior lookup. */
function priorKey(playbookKey: string, failureReason: string): string {
  return `${playbookKey}::${failureReason}`;
}

/**
 * Score every eligible playbook against one opportunity.
 *
 * Returns one candidate per active playbook, ordered by playbook key. The order
 * is alphabetical ON PURPOSE: sorting by expected net would make the array
 * itself a ranking, and this module does not rank.
 */
export function estimateRecoveryCandidates(input: EstimatorInput): EstimateCandidate[] {
  const { opportunityId, targets, playbooks, priors, config, discountOverridesBps } = input;

  const priorIndex = new Map<string, PlaybookPrior>();
  for (const prior of priors) {
    priorIndex.set(priorKey(prior.playbookKey, prior.failureReason), prior);
  }

  const eligible = playbooks.filter((playbook) => playbook.isActive);
  const ordered = [...eligible].sort((a, b) => a.key.localeCompare(b.key));

  return ordered.map((playbook) =>
    scorePlaybook({
      opportunityId,
      playbook,
      targets,
      priorIndex,
      config,
      discountBps: discountOverridesBps?.[playbook.key] ?? playbook.defaultDiscountBps,
    }),
  );
}

interface ScoreArgs {
  opportunityId: string;
  playbook: EstimatorPlaybook;
  targets: readonly EstimatorInput["targets"][number][];
  priorIndex: Map<string, PlaybookPrior>;
  config: EstimatorInput["config"];
  discountBps: number;
}

function scorePlaybook(args: ScoreArgs): EstimateCandidate {
  const { opportunityId, playbook, targets, priorIndex, config, discountBps } = args;

  const breakdowns: TargetBreakdown[] = [];
  let expectedGrossPaise = 0;
  let discountCostPaise = 0;
  let gatewayFeePaise = 0;
  let totalTargetAmountPaise = 0;

  // Confidence follows the WEAKEST prior in play, not the average: an estimate
  // is only as trustworthy as its shakiest component.
  let minPriorSampleSize = Number.POSITIVE_INFINITY;
  let totalRealObservations = 0;
  let targetsWithPrior = 0;

  const incentiveBpsValue = incentiveModifierBps(
    discountBps,
    playbook.defaultDiscountBps,
    config.incentiveBands,
  );

  for (const target of targets) {
    const prior = priorIndex.get(priorKey(playbook.key, target.failureReason));
    const priorFound = prior !== undefined;

    // A missing prior does not silently drop the target's value; it uses a
    // conservative configured rate and drags data completeness -- and therefore
    // confidence -- down, which is the honest signal.
    const baseRateBps = priorFound
      ? baseRateBpsFromPrior(prior)
      : config.fallbackBaseRateBps;
    const sampleSize = priorFound ? priorSampleSize(prior) : 0;

    if (priorFound) {
      targetsWithPrior += 1;
      totalRealObservations += prior.observationCount;
    }
    minPriorSampleSize = Math.min(minPriorSampleSize, sampleSize);

    const recencyBps = recencyModifierBps(target.failureAgeDays, config.recencyBands);
    const tierBps = tierModifierBps(target.customerTier, config);

    const pRecoverBps = chainBps(baseRateBps, recencyBps, tierBps, incentiveBpsValue);

    // Integer paise, half-up rounding, at every step.
    const targetGross = applyBps(target.amountPaise, pRecoverBps);
    const targetDiscount = applyBps(targetGross, discountBps);
    const targetCollected = targetGross - targetDiscount;
    const targetGatewayFee = applyBps(targetCollected, config.gatewayFeeBps);

    expectedGrossPaise += targetGross;
    discountCostPaise += targetDiscount;
    gatewayFeePaise += targetGatewayFee;
    totalTargetAmountPaise += target.amountPaise;

    breakdowns.push({
      transactionId: target.transactionId,
      transactionRef: target.transactionRef,
      customerId: target.customerId,
      customerRef: target.customerRef,
      amountPaise: target.amountPaise,
      failureReason: target.failureReason,
      customerTier: target.customerTier,
      failureAgeDays: target.failureAgeDays,
      baseRateBps,
      priorFound,
      priorSampleSize: sampleSize,
      recencyModifierBps: recencyBps,
      tierModifierBps: tierBps,
      incentiveModifierBps: incentiveBpsValue,
      pRecoverBps,
      expectedGrossPaise: targetGross,
      discountCostPaise: targetDiscount,
      gatewayFeePaise: targetGatewayFee,
    });
  }

  // One outbound contact per target.
  const channelCostPaise = playbook.channelCostPaise * targets.length;
  const costPaise = discountCostPaise + channelCostPaise + gatewayFeePaise;
  const expectedNetPaise = expectedGrossPaise - costPaise;

  // Value-weighted mean probability, derived from the money rather than stated
  // alongside it, so the two can never disagree.
  const pRecoverAvgBps =
    totalTargetAmountPaise > 0
      ? Math.round((expectedGrossPaise * BPS_ONE) / totalTargetAmountPaise)
      : 0;

  const dataCompletenessBps =
    targets.length > 0 ? Math.round((targetsWithPrior * BPS_ONE) / targets.length) : 0;

  const resolvedMinSample = Number.isFinite(minPriorSampleSize) ? minPriorSampleSize : 0;

  const confidence = resolveConfidence(
    {
      minPriorSampleSize: resolvedMinSample,
      totalRealObservations,
      dataCompletenessBps,
    },
    config.confidence,
  );

  return {
    opportunityId,
    playbookId: playbook.id,
    playbookKey: playbook.key,
    expectedGrossPaise,
    discountCostPaise,
    channelCostPaise,
    gatewayFeePaise,
    costPaise,
    expectedNetPaise,
    pRecoverAvgBps,
    confidence,
    estimatorVersion: ESTIMATOR_VERSION,
    inputsSnapshot: {
      estimatorVersion: ESTIMATOR_VERSION,
      playbookKey: playbook.key,
      playbookName: playbook.name,
      actionType: playbook.actionType,
      discountBps,
      defaultDiscountBps: playbook.defaultDiscountBps,
      discountOverridden: discountBps !== playbook.defaultDiscountBps,
      channelCostPaisePerTarget: playbook.channelCostPaise,
      gatewayFeeBps: config.gatewayFeeBps,
      targetCount: targets.length,
      totalTargetAmountPaise,
      config: {
        recencyBands: config.recencyBands,
        tierModifiersBps: config.tierModifiersBps,
        defaultTierModifierBps: config.defaultTierModifierBps,
        incentiveBands: config.incentiveBands,
        fallbackBaseRateBps: config.fallbackBaseRateBps,
        confidence: config.confidence,
      },
      confidenceInputs: {
        minPriorSampleSize: resolvedMinSample,
        totalRealObservations,
        targetsWithPrior,
        dataCompletenessBps,
        resolved: confidence,
      },
      targets: breakdowns,
    },
  };
}
