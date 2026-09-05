/**
 * Types for the deterministic estimator.
 *
 * Framework-free: no Prisma, no network, no LLM. Everything the estimator needs
 * arrives as explicit input, which is what lets a test pin down every number.
 *
 * FIXED-POINT THROUGHOUT.
 *   Money        integer paise.
 *   Probability  basis points, 0..10000 (10000 = 100%).
 *   Modifiers    basis points, where 10000 = x1.0 and values may exceed 10000.
 *   Prior counts milli-units (x1000), matching PlaybookStat storage.
 * No float ever touches a monetary or probabilistic value.
 */

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

/** One qualifying target handed over by the detector. Observed facts only. */
export interface EstimatorTarget {
  transactionId: string;
  transactionRef: string;
  customerId: string;
  customerRef: string;
  /** The full failed ticket, in integer paise. */
  amountPaise: number;
  /** Operative reason, from the LAST failed attempt. */
  failureReason: string;
  customerTier: string;
  /** Whole days between the operative failure and the reference instant. */
  failureAgeDays: number;
}

/** A playbook available for scoring. Parameters come from merchant config. */
export interface EstimatorPlaybook {
  id: string;
  key: string;
  name: string;
  actionType: string;
  /** The discount this playbook is configured to offer. */
  defaultDiscountBps: number;
  /** Cost of one outbound contact, integer paise. */
  channelCostPaise: number;
  isActive: boolean;
}

/**
 * A Beta prior for (playbook, failure reason).
 *
 * Stored as milli-units so learning updates stay exactly reproducible.
 * `observationCount` is REAL outcomes, still zero until the LEARN step runs —
 * distinct from the pseudo-counts, and the difference matters for confidence.
 */
export interface PlaybookPrior {
  playbookKey: string;
  failureReason: string;
  alphaMilli: number;
  betaMilli: number;
  observationCount: number;
}

/** A banded modifier: `maxDays`/`maxBps` is an inclusive upper bound. */
export interface RecencyBand {
  maxDays: number;
  modifierBps: number;
}

export interface IncentiveBand {
  /** Inclusive upper bound on discount ABOVE the playbook default. */
  maxDeltaBps: number;
  modifierBps: number;
}

export interface ConfidenceThresholds {
  /** Pseudo-observations behind a prior, e.g. alpha+beta. */
  highMinSampleSize: number;
  mediumMinSampleSize: number;
  /** Real recorded outcomes required before HIGH is reachable. */
  highMinRealObservations: number;
  /** Share of targets with a matching prior, in bps. */
  highMinCompletenessBps: number;
  mediumMinCompletenessBps: number;
}

/**
 * Calibration for the estimator.
 *
 * Passed in, never reached for: the pure estimator holds no policy of its own,
 * so a merchant can retune it without a code change and a test can vary any
 * value freely.
 */
export interface EstimatorConfig {
  /** Ordered ascending by `maxDays`; the first match wins. */
  recencyBands: readonly RecencyBand[];
  /** Modifier per customer tier, e.g. { HIGH: 11000 }. */
  tierModifiersBps: Readonly<Record<string, number>>;
  /** Applied when no tier entry matches. */
  defaultTierModifierBps: number;
  /** Ordered ascending by `maxDeltaBps`; the first match wins. */
  incentiveBands: readonly IncentiveBand[];
  /** Gateway fee on collected revenue, in bps. */
  gatewayFeeBps: number;
  /** Used when no prior exists for a (playbook, reason) pair. */
  fallbackBaseRateBps: number;
  confidence: ConfidenceThresholds;
}

export interface EstimatorInput {
  opportunityId: string;
  targets: readonly EstimatorTarget[];
  playbooks: readonly EstimatorPlaybook[];
  priors: readonly PlaybookPrior[];
  config: EstimatorConfig;
  /**
   * Per-playbook discount override. Absent means use the playbook default.
   * Present so a merchant can propose a deeper discount without a code change.
   */
  discountOverridesBps?: Readonly<Record<string, number>>;
}

/** Every factor behind one target's probability, kept for the audit trail. */
export interface TargetBreakdown {
  transactionId: string;
  transactionRef: string;
  customerId: string;
  customerRef: string;
  amountPaise: number;
  failureReason: string;
  customerTier: string;
  failureAgeDays: number;
  baseRateBps: number;
  /** False when no prior matched and the fallback rate was used. */
  priorFound: boolean;
  priorSampleSize: number;
  recencyModifierBps: number;
  tierModifierBps: number;
  incentiveModifierBps: number;
  pRecoverBps: number;
  expectedGrossPaise: number;
  discountCostPaise: number;
  gatewayFeePaise: number;
}

/**
 * Everything needed to reproduce the result without re-reading the database.
 * Deterministic inputs only — never an LLM-generated explanation.
 */
export interface EstimateInputsSnapshot {
  estimatorVersion: string;
  playbookKey: string;
  playbookName: string;
  actionType: string;
  discountBps: number;
  defaultDiscountBps: number;
  discountOverridden: boolean;
  channelCostPaisePerTarget: number;
  gatewayFeeBps: number;
  targetCount: number;
  totalTargetAmountPaise: number;
  config: {
    recencyBands: readonly RecencyBand[];
    tierModifiersBps: Readonly<Record<string, number>>;
    defaultTierModifierBps: number;
    incentiveBands: readonly IncentiveBand[];
    fallbackBaseRateBps: number;
    confidence: ConfidenceThresholds;
  };
  confidenceInputs: {
    minPriorSampleSize: number;
    totalRealObservations: number;
    targetsWithPrior: number;
    dataCompletenessBps: number;
    resolved: ConfidenceLevel;
  };
  targets: readonly TargetBreakdown[];
}

/**
 * One scored (opportunity, playbook) pair.
 *
 * Note what is absent: no `selected`, `winner`, `recommended`, or `rank`. The
 * estimator SCORES; choosing belongs to the reasoner, with a deterministic
 * argmax fallback that lives outside this module.
 */
export interface EstimateCandidate {
  opportunityId: string;
  playbookId: string;
  playbookKey: string;
  expectedGrossPaise: number;
  discountCostPaise: number;
  channelCostPaise: number;
  gatewayFeePaise: number;
  costPaise: number;
  /** expectedGrossPaise - costPaise. May be negative; a guardrail blocks those. */
  expectedNetPaise: number;
  /** Value-weighted mean recovery probability, in bps. */
  pRecoverAvgBps: number;
  confidence: ConfidenceLevel;
  inputsSnapshot: EstimateInputsSnapshot;
  estimatorVersion: string;
}
