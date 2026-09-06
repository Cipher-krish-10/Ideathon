/**
 * The attribution engine.
 *
 * Pure: no I/O, no clock read. Given a verified payment and the interventions
 * that could explain it, decide which one gets the credit — or refuse.
 *
 * Priority, in order:
 *   1. DIRECT_REF   — the payment carries a reference we minted. Unambiguous.
 *   2. WINDOW_MATCH — same customer, matching amount, inside the window, and
 *                     exactly one candidate. Probable, and labelled as such.
 *   3. UNATTRIBUTED — anything else.
 *
 * There is no fourth option where the engine guesses.
 */
import type {
  AttributionArtifact,
  AttributionCandidate,
  AttributionConfig,
  AttributionDecision,
  NormalisedPayment,
} from "./types";

const MS_PER_DAY = 86_400_000;

/** Is `observed` within tolerance of `expected`? Integer arithmetic only. */
export function amountsMatch(
  observedPaise: number,
  expectedPaise: number,
  toleranceBps: number,
): boolean {
  const tolerance = Math.round((expectedPaise * toleranceBps) / 10_000);
  return Math.abs(observedPaise - expectedPaise) <= tolerance;
}

interface ArtifactMatch {
  candidate: AttributionCandidate;
  artifact: AttributionArtifact;
}

function findByReference(
  candidates: readonly AttributionCandidate[],
  referenceId: string,
): ArtifactMatch[] {
  const matches: ArtifactMatch[] = [];
  for (const candidate of candidates) {
    for (const artifact of candidate.artifacts) {
      if (artifact.referenceId === referenceId) matches.push({ candidate, artifact });
    }
  }
  return matches;
}

function withinWindow(
  candidate: AttributionCandidate,
  payment: NormalisedPayment,
  config: AttributionConfig,
): boolean {
  if (!candidate.executedAt) return false;
  const elapsed = payment.occurredAt.getTime() - candidate.executedAt.getTime();
  // A payment before the link existed cannot have been caused by it.
  return elapsed >= 0 && elapsed <= config.attributionWindowDays * MS_PER_DAY;
}

export function attributePayment(
  payment: NormalisedPayment,
  candidates: readonly AttributionCandidate[],
  config: AttributionConfig,
): AttributionDecision {
  const consideredInterventionIds = candidates.map((candidate) => candidate.interventionId);

  if (candidates.length === 0) {
    return {
      attributed: false,
      reason: "NO_CANDIDATE_INTERVENTION",
      detail: "No executed intervention could explain this payment.",
      consideredInterventionIds,
    };
  }

  // ---- 1. DIRECT_REF ------------------------------------------------------
  // The payment carries a reference we minted, so there is nothing to infer.
  if (payment.referenceId) {
    const matches = findByReference(candidates, payment.referenceId);

    if (matches.length === 1) {
      const { candidate, artifact } = matches[0]!;

      if (candidate.alreadyAttributedTransactionIds.includes(artifact.transactionId)) {
        return {
          attributed: false,
          reason: "ALREADY_ATTRIBUTED",
          detail: `Transaction ${artifact.transactionId} is already credited to this intervention.`,
          consideredInterventionIds,
        };
      }
      // The amount is still checked: a reference match with the wrong amount
      // means something is wrong that we should surface, not paper over.
      if (!amountsMatch(payment.amountPaise, artifact.amountPaise, config.amountToleranceBps)) {
        return {
          attributed: false,
          reason: "AMOUNT_MISMATCH",
          detail:
            `Reference ${payment.referenceId} matches, but the payment of ` +
            `${payment.amountPaise} paise differs from the ${artifact.amountPaise} paise requested.`,
          consideredInterventionIds,
        };
      }

      return {
        attributed: true,
        method: "DIRECT_REF",
        confidence: "HIGH",
        interventionId: candidate.interventionId,
        transactionId: artifact.transactionId,
        customerId: artifact.customerId,
        // The amount actually paid, from the verified event. Never the estimate.
        attributedAmountPaise: payment.amountPaise,
        reason: `Payment carries reference ${payment.referenceId}, minted for this intervention.`,
      };
    }

    if (matches.length > 1) {
      // Should be impossible — references are unique — but refusing beats
      // picking one at random.
      return {
        attributed: false,
        reason: "AMBIGUOUS_COMPETING_INTERVENTIONS",
        detail: `Reference ${payment.referenceId} matched ${matches.length} artifacts.`,
        consideredInterventionIds,
      };
    }

    // The payment names a reference that is not ours. Falling through to
    // circumstantial matching here would let a payment that explicitly belongs
    // to something else be credited to one of our interventions.
    if (matches.length === 0 && !payment.attributionRef) {
      return {
        attributed: false,
        reason: "REFERENCE_UNKNOWN",
        detail:
          `Payment carries reference ${payment.referenceId}, which does not belong to any ` +
          "executed intervention. Refusing to attribute it circumstantially.",
        consideredInterventionIds,
      };
    }
  }

  // A reference we did not mint must never be force-fitted onto a candidate.
  if (payment.attributionRef) {
    const owning = candidates.filter(
      (candidate) => candidate.attributionRef === payment.attributionRef,
    );
    if (owning.length === 1) {
      const candidate = owning[0]!;
      const byAmount = candidate.artifacts.filter(
        (artifact) =>
          amountsMatch(payment.amountPaise, artifact.amountPaise, config.amountToleranceBps) &&
          !candidate.alreadyAttributedTransactionIds.includes(artifact.transactionId),
      );
      if (byAmount.length === 1) {
        const artifact = byAmount[0]!;
        return {
          attributed: true,
          method: "DIRECT_REF",
          confidence: "HIGH",
          interventionId: candidate.interventionId,
          transactionId: artifact.transactionId,
          customerId: artifact.customerId,
          attributedAmountPaise: payment.amountPaise,
          reason:
            `Payment notes carry attribution reference ${payment.attributionRef}, and the ` +
            "amount identifies exactly one outstanding target.",
        };
      }
      if (byAmount.length > 1) {
        return {
          attributed: false,
          reason: "AMBIGUOUS_COMPETING_INTERVENTIONS",
          detail:
            `Attribution reference ${payment.attributionRef} matched the intervention, but ` +
            `${byAmount.length} of its targets share this amount. Refusing to pick one.`,
          consideredInterventionIds,
        };
      }
      return {
        attributed: false,
        reason: "AMOUNT_MISMATCH",
        detail:
          `Attribution reference ${payment.attributionRef} matched an intervention, but no ` +
          "outstanding target matches this amount.",
        consideredInterventionIds,
      };
    }

    // The reference names an intervention we do not have. It belongs to
    // something else, and guessing would be attributing another system's money.
    return {
      attributed: false,
      reason: "REFERENCE_UNKNOWN",
      detail:
        `Payment carries attribution reference ${payment.attributionRef}, which matches no ` +
        "executed intervention. Refusing to attribute it circumstantially.",
      consideredInterventionIds,
    };
  }

  // ---- 2. WINDOW_MATCH ----------------------------------------------------
  // No reference. Fall back to circumstantial evidence, and only when it points
  // at exactly one intervention.
  const windowMatches: ArtifactMatch[] = [];
  for (const candidate of candidates) {
    if (!withinWindow(candidate, payment, config)) continue;
    for (const artifact of candidate.artifacts) {
      if (candidate.alreadyAttributedTransactionIds.includes(artifact.transactionId)) continue;
      if (!amountsMatch(payment.amountPaise, artifact.amountPaise, config.amountToleranceBps)) continue;
      windowMatches.push({ candidate, artifact });
    }
  }

  if (windowMatches.length === 1) {
    const { candidate, artifact } = windowMatches[0]!;
    return {
      attributed: true,
      method: "WINDOW_MATCH",
      confidence: "MEDIUM",
      interventionId: candidate.interventionId,
      transactionId: artifact.transactionId,
      customerId: artifact.customerId,
      attributedAmountPaise: payment.amountPaise,
      reason:
        "No provider reference, but exactly one executed intervention targeted this " +
        "customer for this amount inside the attribution window.",
    };
  }

  if (windowMatches.length > 1) {
    // Two interventions could each explain it. Crediting either would be a
    // coin flip presented as a fact.
    return {
      attributed: false,
      reason: "AMBIGUOUS_COMPETING_INTERVENTIONS",
      detail:
        `${windowMatches.length} interventions could each explain this payment. ` +
        "Refusing to credit any of them.",
      consideredInterventionIds,
    };
  }

  // Nothing matched. Say specifically why.
  const anyInWindow = candidates.some((candidate) => withinWindow(candidate, payment, config));
  if (!anyInWindow) {
    return {
      attributed: false,
      reason: "OUTSIDE_ATTRIBUTION_WINDOW",
      detail:
        `No executed intervention falls within ${config.attributionWindowDays} days of this payment.`,
      consideredInterventionIds,
    };
  }

  return {
    attributed: false,
    reason: "AMOUNT_MISMATCH",
    detail:
      `No outstanding target matches ${payment.amountPaise} paise within ` +
      `${config.amountToleranceBps} bps tolerance.`,
    consideredInterventionIds,
  };
}
