import { describe, expect, it } from "vitest";

import {
  BPS_ONE,
  ESTIMATOR_VERSION,
  baseRateBpsFromPrior,
  chainBps,
  estimateRecoveryCandidates,
  incentiveModifierBps,
  recencyModifierBps,
  resolveConfidence,
  tierModifierBps,
} from "@/core/estimator";
import type {
  EstimatorConfig,
  EstimatorInput,
  EstimatorPlaybook,
  EstimatorTarget,
  PlaybookPrior,
} from "@/core/estimator";

/**
 * Unit tests for the pure estimator.
 *
 * Fixtures are chosen so expected values can be worked out by hand, which is
 * the only way to tell "the code is consistent with itself" apart from "the
 * code is right".
 */

const CONFIG: EstimatorConfig = {
  recencyBands: [
    { maxDays: 3, modifierBps: 11_500 },
    { maxDays: 7, modifierBps: 10_500 },
    { maxDays: 14, modifierBps: 10_000 },
    { maxDays: 30, modifierBps: 8_500 },
    { maxDays: Number.MAX_SAFE_INTEGER, modifierBps: 7_000 },
  ],
  tierModifiersBps: { HIGH: 11_000, MEDIUM: 10_000, LOW: 9_000 },
  defaultTierModifierBps: 10_000,
  incentiveBands: [
    { maxDeltaBps: 0, modifierBps: 10_000 },
    { maxDeltaBps: 500, modifierBps: 10_400 },
    { maxDeltaBps: 1_000, modifierBps: 10_800 },
    { maxDeltaBps: Number.MAX_SAFE_INTEGER, modifierBps: 11_100 },
  ],
  gatewayFeeBps: 200,
  fallbackBaseRateBps: 500,
  confidence: {
    highMinSampleSize: 100,
    mediumMinSampleSize: 30,
    highMinRealObservations: 30,
    highMinCompletenessBps: 10_000,
    mediumMinCompletenessBps: 8_000,
  },
};

const REMINDER: EstimatorPlaybook = {
  id: "pb-reminder", key: "REMINDER_ONLY", name: "Plain retry reminder",
  actionType: "REMINDER_ONLY", defaultDiscountBps: 0, channelCostPaise: 50, isActive: true,
};
const PLAIN_LINK: EstimatorPlaybook = {
  id: "pb-plain", key: "PAYMENT_LINK_PLAIN", name: "Payment link, no incentive",
  actionType: "PAYMENT_LINK_PLAIN", defaultDiscountBps: 0, channelCostPaise: 50, isActive: true,
};
const OFFER_LINK: EstimatorPlaybook = {
  id: "pb-offer", key: "PAYMENT_LINK_WITH_OFFER", name: "Payment link with capped discount",
  actionType: "PAYMENT_LINK_WITH_OFFER", defaultDiscountBps: 1_000, channelCostPaise: 50, isActive: true,
};

/** Beta(20, 20) = a clean 50% base rate, so hand-arithmetic stays legible. */
function prior(
  playbookKey: string,
  overrides: Partial<PlaybookPrior> = {},
): PlaybookPrior {
  return {
    playbookKey, failureReason: "EXPIRED_CARD",
    alphaMilli: 20_000, betaMilli: 20_000, observationCount: 0,
    ...overrides,
  };
}

function target(overrides: Partial<EstimatorTarget> = {}): EstimatorTarget {
  return {
    transactionId: "txn-1", transactionRef: "txn_000001",
    customerId: "cus-1", customerRef: "cust_0001",
    amountPaise: 1_000_000, // ₹10,000
    failureReason: "EXPIRED_CARD",
    customerTier: "MEDIUM", // x1.0
    failureAgeDays: 10, // x1.0
    ...overrides,
  };
}

function input(overrides: Partial<EstimatorInput> = {}): EstimatorInput {
  return {
    opportunityId: "opp-1",
    targets: [target()],
    playbooks: [REMINDER, PLAIN_LINK, OFFER_LINK],
    priors: [prior("REMINDER_ONLY"), prior("PAYMENT_LINK_PLAIN"), prior("PAYMENT_LINK_WITH_OFFER")],
    config: CONFIG,
    ...overrides,
  };
}

const byKey = (candidates: ReturnType<typeof estimateRecoveryCandidates>, key: string) =>
  candidates.find((c) => c.playbookKey === key)!;

describe("deterministic estimator", () => {
  describe("1-3. single target, one candidate per playbook", () => {
    it("scores a reminder with zero discount cost", () => {
      const candidate = byKey(estimateRecoveryCandidates(input()), "REMINDER_ONLY");

      // 50% base x 1.0 recency x 1.0 tier x 1.0 incentive = 50%
      expect(candidate.pRecoverAvgBps).toBe(5_000);
      expect(candidate.expectedGrossPaise).toBe(500_000); // ₹10,000 x 50%
      expect(candidate.discountCostPaise).toBe(0);
      expect(candidate.channelCostPaise).toBe(50);
      expect(candidate.gatewayFeePaise).toBe(10_000); // 2% of ₹5,000 collected
      expect(candidate.costPaise).toBe(10_050);
      expect(candidate.expectedNetPaise).toBe(489_950);
    });

    it("scores a plain payment link with zero discount cost", () => {
      const candidate = byKey(estimateRecoveryCandidates(input()), "PAYMENT_LINK_PLAIN");
      expect(candidate.discountCostPaise).toBe(0);
      expect(candidate.expectedGrossPaise).toBe(500_000);
      expect(candidate.expectedNetPaise).toBe(489_950);
    });

    it("scores an offer, charging the discount only on expected recovered revenue", () => {
      const candidate = byKey(estimateRecoveryCandidates(input()), "PAYMENT_LINK_WITH_OFFER");

      // At the playbook's own default discount the incentive modifier is x1.0,
      // so probability is unchanged; only the cost side moves.
      expect(candidate.pRecoverAvgBps).toBe(5_000);
      expect(candidate.expectedGrossPaise).toBe(500_000);
      // 10% of expected gross — a discount is only conceded on payments that arrive.
      expect(candidate.discountCostPaise).toBe(50_000);
      // Gateway fee on what is actually collected: ₹5,000 - ₹500 = ₹4,500.
      expect(candidate.gatewayFeePaise).toBe(9_000);
      expect(candidate.costPaise).toBe(50_000 + 50 + 9_000);
      expect(candidate.expectedNetPaise).toBe(500_000 - 59_050);
    });

    it("returns exactly one candidate per active playbook", () => {
      const candidates = estimateRecoveryCandidates(input());
      expect(candidates).toHaveLength(3);
      expect(candidates.map((c) => c.playbookKey).sort()).toEqual([
        "PAYMENT_LINK_PLAIN", "PAYMENT_LINK_WITH_OFFER", "REMINDER_ONLY",
      ]);
    });

    it("skips inactive playbooks", () => {
      const candidates = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER, { ...OFFER_LINK, isActive: false }] }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.playbookKey).toBe("REMINDER_ONLY");
    });
  });

  describe("4-7. probability modifiers", () => {
    it("derives the base rate from the Beta prior", () => {
      expect(baseRateBpsFromPrior(prior("X"))).toBe(5_000);
      expect(baseRateBpsFromPrior(prior("X", { alphaMilli: 18_800, betaMilli: 21_200 }))).toBe(4_700);
      expect(baseRateBpsFromPrior(prior("X", { alphaMilli: 0, betaMilli: 0 }))).toBe(0);
    });

    it("applies recency bands by inclusive upper bound", () => {
      expect(recencyModifierBps(0, CONFIG.recencyBands)).toBe(11_500);
      expect(recencyModifierBps(3, CONFIG.recencyBands)).toBe(11_500);
      expect(recencyModifierBps(4, CONFIG.recencyBands)).toBe(10_500);
      expect(recencyModifierBps(14, CONFIG.recencyBands)).toBe(10_000);
      expect(recencyModifierBps(30, CONFIG.recencyBands)).toBe(8_500);
      expect(recencyModifierBps(999, CONFIG.recencyBands)).toBe(7_000);
    });

    it("moves the estimate when the failure is fresher", () => {
      const fresh = byKey(
        estimateRecoveryCandidates(input({ targets: [target({ failureAgeDays: 1 })] })),
        "REMINDER_ONLY",
      );
      // 50% x 1.15 = 57.5%
      expect(fresh.pRecoverAvgBps).toBe(5_750);
      expect(fresh.expectedGrossPaise).toBe(575_000);
    });

    it("applies tier modifiers, falling back for an unknown tier", () => {
      expect(tierModifierBps("HIGH", CONFIG)).toBe(11_000);
      expect(tierModifierBps("LOW", CONFIG)).toBe(9_000);
      expect(tierModifierBps("PLATINUM", CONFIG)).toBe(10_000);

      const high = byKey(
        estimateRecoveryCandidates(input({ targets: [target({ customerTier: "HIGH" })] })),
        "REMINDER_ONLY",
      );
      expect(high.pRecoverAvgBps).toBe(5_500); // 50% x 1.1
    });

    it("treats the incentive modifier as a DELTA above the playbook default", () => {
      // The priors are per playbook, so an offer's base rate already includes
      // its standard discount. At the default the modifier must be exactly 1.0,
      // or the incentive gets counted twice.
      expect(incentiveModifierBps(1_000, 1_000, CONFIG.incentiveBands)).toBe(10_000);
      expect(incentiveModifierBps(0, 0, CONFIG.incentiveBands)).toBe(10_000);
      // Below default earns no uplift, and is not modelled as a penalty.
      expect(incentiveModifierBps(500, 1_000, CONFIG.incentiveBands)).toBe(10_000);
      // Above default does lift.
      expect(incentiveModifierBps(1_500, 1_000, CONFIG.incentiveBands)).toBe(10_400);
      expect(incentiveModifierBps(2_000, 1_000, CONFIG.incentiveBands)).toBe(10_800);
      expect(incentiveModifierBps(5_000, 1_000, CONFIG.incentiveBands)).toBe(11_100);
    });

    it("raises probability and cost when a deeper discount is proposed", () => {
      const base = byKey(estimateRecoveryCandidates(input()), "PAYMENT_LINK_WITH_OFFER");
      const deeper = byKey(
        estimateRecoveryCandidates(
          input({ discountOverridesBps: { PAYMENT_LINK_WITH_OFFER: 2_000 } }),
        ),
        "PAYMENT_LINK_WITH_OFFER",
      );

      expect(deeper.pRecoverAvgBps).toBeGreaterThan(base.pRecoverAvgBps);
      expect(deeper.discountCostPaise).toBeGreaterThan(base.discountCostPaise);
      expect(deeper.inputsSnapshot.discountOverridden).toBe(true);
      expect(deeper.inputsSnapshot.discountBps).toBe(2_000);
    });

    it("chains modifiers exactly, with one rounding at the end", () => {
      // Rounding after each factor would make the result depend on factor order.
      expect(chainBps(5_000, 11_000, 11_500)).toBe(6_325);
      expect(chainBps(5_000, 11_500, 11_000)).toBe(6_325);
      expect(chainBps(5_000)).toBe(5_000);
      // Probability can never exceed 100% however many uplifts are applied.
      expect(chainBps(9_000, 20_000, 20_000)).toBe(BPS_ONE);
    });

    it("stays exact where naive float multiplication would drift", () => {
      // 3333 x 1.0001^4 chained; BigInt keeps the intermediate product exact.
      const result = chainBps(3_333, 10_001, 10_001, 10_001, 10_001);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBe(3_334);
    });
  });

  describe("8-11. money arithmetic", () => {
    it("computes expected gross as amount x probability, summed", () => {
      const candidates = estimateRecoveryCandidates(
        input({
          targets: [
            target({ transactionId: "t1", amountPaise: 1_000_000 }),
            target({ transactionId: "t2", amountPaise: 500_000 }),
          ],
        }),
      );
      const reminder = byKey(candidates, "REMINDER_ONLY");
      expect(reminder.expectedGrossPaise).toBe(500_000 + 250_000);
    });

    it("computes net as gross minus the summed cost components", () => {
      for (const candidate of estimateRecoveryCandidates(input())) {
        expect(candidate.costPaise).toBe(
          candidate.discountCostPaise + candidate.channelCostPaise + candidate.gatewayFeePaise,
        );
        expect(candidate.expectedNetPaise).toBe(
          candidate.expectedGrossPaise - candidate.costPaise,
        );
      }
    });

    it("charges zero discount for both zero-discount playbooks", () => {
      const candidates = estimateRecoveryCandidates(input());
      expect(byKey(candidates, "REMINDER_ONLY").discountCostPaise).toBe(0);
      expect(byKey(candidates, "PAYMENT_LINK_PLAIN").discountCostPaise).toBe(0);
    });

    it("charges channel cost once per target", () => {
      const candidates = estimateRecoveryCandidates(
        input({
          targets: [
            target({ transactionId: "t1" }),
            target({ transactionId: "t2" }),
            target({ transactionId: "t3" }),
          ],
        }),
      );
      expect(byKey(candidates, "REMINDER_ONLY").channelCostPaise).toBe(150);
    });

    it("may produce a negative net without failing — a guardrail blocks those later", () => {
      const expensive: EstimatorPlaybook = {
        ...REMINDER, id: "pb-x", key: "EXPENSIVE", channelCostPaise: 10_000_000,
      };
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [expensive], priors: [prior("EXPENSIVE")] }),
      )[0]!;
      expect(candidate.expectedNetPaise).toBeLessThan(0);
      expect(candidate.expectedGrossPaise).toBeGreaterThan(0);
    });
  });

  describe("12-13. confidence", () => {
    it("resolves MEDIUM for seeded priors with no real outcomes", () => {
      // 40 pseudo-observations, zero real ones. A stated belief is not evidence.
      const candidate = estimateRecoveryCandidates(
        input({ priors: [prior("REMINDER_ONLY", { alphaMilli: 20_000, betaMilli: 20_000 })],
                playbooks: [REMINDER] }),
      )[0]!;
      expect(candidate.confidence).toBe("MEDIUM");
      expect(candidate.inputsSnapshot.confidenceInputs.minPriorSampleSize).toBe(40);
      expect(candidate.inputsSnapshot.confidenceInputs.totalRealObservations).toBe(0);
    });

    it("resolves LOW for a thin prior", () => {
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER],
                priors: [prior("REMINDER_ONLY", { alphaMilli: 2_000, betaMilli: 3_000 })] }),
      )[0]!;
      expect(candidate.confidence).toBe("LOW");
    });

    it("resolves HIGH only with a strong prior AND real observations", () => {
      const strong = prior("REMINDER_ONLY", {
        alphaMilli: 60_000, betaMilli: 60_000, observationCount: 50,
      });
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER], priors: [strong] }),
      )[0]!;
      expect(candidate.confidence).toBe("HIGH");
    });

    it("withholds HIGH when the prior is strong but nothing has been observed", () => {
      const unobserved = prior("REMINDER_ONLY", {
        alphaMilli: 60_000, betaMilli: 60_000, observationCount: 0,
      });
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER], priors: [unobserved] }),
      )[0]!;
      expect(candidate.confidence).toBe("MEDIUM");
    });

    it("drops confidence when a prior is missing, and says so in the snapshot", () => {
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER], priors: [] }),
      )[0]!;
      expect(candidate.confidence).toBe("LOW");
      expect(candidate.inputsSnapshot.confidenceInputs.dataCompletenessBps).toBe(0);
      expect(candidate.inputsSnapshot.targets[0]!.priorFound).toBe(false);
      // The conservative fallback rate was used, not a silent drop of the target.
      expect(candidate.inputsSnapshot.targets[0]!.baseRateBps).toBe(500);
      expect(candidate.expectedGrossPaise).toBeGreaterThan(0);
    });

    it("follows the weakest prior when targets differ", () => {
      const candidate = estimateRecoveryCandidates(
        input({
          playbooks: [REMINDER],
          targets: [
            target({ transactionId: "t1", failureReason: "EXPIRED_CARD" }),
            target({ transactionId: "t2", failureReason: "UNKNOWN" }),
          ],
          priors: [
            prior("REMINDER_ONLY", { failureReason: "EXPIRED_CARD", alphaMilli: 60_000, betaMilli: 60_000, observationCount: 99 }),
            prior("REMINDER_ONLY", { failureReason: "UNKNOWN", alphaMilli: 2_000, betaMilli: 2_000 }),
          ],
        }),
      )[0]!;
      expect(candidate.inputsSnapshot.confidenceInputs.minPriorSampleSize).toBe(4);
      expect(candidate.confidence).toBe("LOW");
    });

    it("exposes the threshold function directly", () => {
      const t = CONFIG.confidence;
      expect(resolveConfidence({ minPriorSampleSize: 120, totalRealObservations: 40, dataCompletenessBps: 10_000 }, t)).toBe("HIGH");
      expect(resolveConfidence({ minPriorSampleSize: 40, totalRealObservations: 0, dataCompletenessBps: 10_000 }, t)).toBe("MEDIUM");
      expect(resolveConfidence({ minPriorSampleSize: 40, totalRealObservations: 0, dataCompletenessBps: 5_000 }, t)).toBe("LOW");
    });
  });

  describe("14. multiple targets aggregate correctly", () => {
    it("sums per-target figures and derives the value-weighted average p", () => {
      const candidate = estimateRecoveryCandidates(
        input({
          playbooks: [REMINDER],
          targets: [
            target({ transactionId: "t1", amountPaise: 1_000_000, customerTier: "HIGH" }),
            target({ transactionId: "t2", amountPaise: 200_000, customerTier: "LOW" }),
          ],
        }),
      )[0]!;

      // t1: 50% x 1.1 = 55% of ₹10,000 = ₹5,500
      // t2: 50% x 0.9 = 45% of ₹2,000  = ₹900
      expect(candidate.expectedGrossPaise).toBe(550_000 + 90_000);
      // Value-weighted, so it is implied by the money rather than stated beside it.
      expect(candidate.pRecoverAvgBps).toBe(
        Math.round((640_000 * 10_000) / 1_200_000),
      );
      expect(candidate.inputsSnapshot.targets).toHaveLength(2);
      expect(candidate.inputsSnapshot.totalTargetAmountPaise).toBe(1_200_000);
    });

    it("handles an empty target list without dividing by zero", () => {
      const candidate = estimateRecoveryCandidates(
        input({ playbooks: [REMINDER], targets: [] }),
      )[0]!;
      expect(candidate.expectedGrossPaise).toBe(0);
      expect(candidate.costPaise).toBe(0);
      expect(candidate.expectedNetPaise).toBe(0);
      expect(candidate.pRecoverAvgBps).toBe(0);
      expect(candidate.confidence).toBe("LOW");
    });
  });

  describe("15-16. integer paise, no floating point", () => {
    it("emits integers for every monetary and probability field", () => {
      const candidates = estimateRecoveryCandidates(
        input({
          targets: [
            target({ transactionId: "t1", amountPaise: 333_333 }),
            target({ transactionId: "t2", amountPaise: 777_777 }),
            target({ transactionId: "t3", amountPaise: 1 }),
          ],
        }),
      );
      for (const candidate of candidates) {
        for (const field of [
          candidate.expectedGrossPaise, candidate.discountCostPaise,
          candidate.channelCostPaise, candidate.gatewayFeePaise,
          candidate.costPaise, candidate.expectedNetPaise, candidate.pRecoverAvgBps,
        ]) {
          expect(Number.isInteger(field)).toBe(true);
        }
        for (const breakdown of candidate.inputsSnapshot.targets) {
          expect(Number.isInteger(breakdown.expectedGrossPaise)).toBe(true);
          expect(Number.isInteger(breakdown.discountCostPaise)).toBe(true);
          expect(Number.isInteger(breakdown.gatewayFeePaise)).toBe(true);
          expect(Number.isInteger(breakdown.pRecoverBps)).toBe(true);
        }
      }
    });

    it("keeps probability within 0..10000 bps", () => {
      const candidates = estimateRecoveryCandidates(
        input({ targets: [target({ customerTier: "HIGH", failureAgeDays: 0 })],
                priors: [prior("REMINDER_ONLY", { alphaMilli: 39_000, betaMilli: 1_000 })] }),
      );
      for (const candidate of candidates) {
        expect(candidate.pRecoverAvgBps).toBeGreaterThanOrEqual(0);
        expect(candidate.pRecoverAvgBps).toBeLessThanOrEqual(10_000);
      }
    });

    it("produces amounts that survive an exact round trip through JSON", () => {
      // A float would not necessarily.
      const candidate = estimateRecoveryCandidates(input())[0]!;
      const roundTripped = JSON.parse(JSON.stringify(candidate)) as typeof candidate;
      expect(roundTripped.expectedNetPaise).toBe(candidate.expectedNetPaise);
      expect(roundTripped.expectedGrossPaise).toBe(candidate.expectedGrossPaise);
    });
  });

  describe("17. determinism", () => {
    it("returns byte-identical results across runs", () => {
      const payload = input({
        targets: [
          target({ transactionId: "t1", amountPaise: 123_457, customerTier: "HIGH", failureAgeDays: 2 }),
          target({ transactionId: "t2", amountPaise: 987_653, customerTier: "LOW", failureAgeDays: 29 }),
        ],
      });
      expect(JSON.stringify(estimateRecoveryCandidates(payload)))
        .toBe(JSON.stringify(estimateRecoveryCandidates(payload)));
    });

    it("does not mutate its inputs", () => {
      const payload = input();
      const before = JSON.stringify(payload);
      estimateRecoveryCandidates(payload);
      expect(JSON.stringify(payload)).toBe(before);
    });

    it("stamps the estimator version on every candidate", () => {
      for (const candidate of estimateRecoveryCandidates(input())) {
        expect(candidate.estimatorVersion).toBe("failed-payment-recovery-estimator:v1");
        expect(candidate.inputsSnapshot.estimatorVersion).toBe(ESTIMATOR_VERSION);
      }
    });
  });

  describe("18. configuration drives the result", () => {
    it("changes estimates when the gateway fee changes", () => {
      const cheap = estimateRecoveryCandidates(
        input({ config: { ...CONFIG, gatewayFeeBps: 0 } }),
      );
      const dear = estimateRecoveryCandidates(
        input({ config: { ...CONFIG, gatewayFeeBps: 500 } }),
      );
      expect(byKey(cheap, "REMINDER_ONLY").gatewayFeePaise).toBe(0);
      expect(byKey(dear, "REMINDER_ONLY").gatewayFeePaise).toBeGreaterThan(0);
      expect(byKey(dear, "REMINDER_ONLY").expectedNetPaise).toBeLessThan(
        byKey(cheap, "REMINDER_ONLY").expectedNetPaise,
      );
    });

    it("changes estimates when tier modifiers change", () => {
      const flattened = estimateRecoveryCandidates(
        input({
          targets: [target({ customerTier: "HIGH" })],
          config: { ...CONFIG, tierModifiersBps: { HIGH: 10_000, MEDIUM: 10_000, LOW: 10_000 } },
        }),
      );
      expect(byKey(flattened, "REMINDER_ONLY").pRecoverAvgBps).toBe(5_000);
    });

    it("changes confidence when thresholds change", () => {
      const lenient = estimateRecoveryCandidates(
        input({
          playbooks: [REMINDER],
          config: {
            ...CONFIG,
            confidence: { ...CONFIG.confidence, highMinSampleSize: 10, highMinRealObservations: 0 },
          },
        }),
      )[0]!;
      expect(lenient.confidence).toBe("HIGH");
    });

    it("records the configuration used, so a stored estimate stays explainable", () => {
      const candidate = estimateRecoveryCandidates(input())[0]!;
      expect(candidate.inputsSnapshot.config.tierModifiersBps).toEqual(CONFIG.tierModifiersBps);
      expect(candidate.inputsSnapshot.config.recencyBands).toEqual(CONFIG.recencyBands);
      expect(candidate.inputsSnapshot.gatewayFeeBps).toBe(200);
      expect(candidate.inputsSnapshot.config.fallbackBaseRateBps).toBe(500);
    });
  });

  describe("19. the estimator scores, it does not choose", () => {
    it("exposes no winner, selection, ranking, or recommendation", () => {
      for (const candidate of estimateRecoveryCandidates(input())) {
        for (const key of [
          "selected", "isSelected", "winner", "isWinner", "recommended",
          "rank", "chosen", "best", "rationale",
        ]) {
          expect(candidate).not.toHaveProperty(key);
        }
      }
    });

    it("orders candidates alphabetically, NOT by expected net", () => {
      // Ordering by value would make the array itself a ranking. Here the
      // highest-net playbook is deliberately not first.
      const candidates = estimateRecoveryCandidates(input());
      expect(candidates.map((c) => c.playbookKey)).toEqual([
        "PAYMENT_LINK_PLAIN", "PAYMENT_LINK_WITH_OFFER", "REMINDER_ONLY",
      ]);

      const netOrder = [...candidates]
        .sort((a, b) => b.expectedNetPaise - a.expectedNetPaise)
        .map((c) => c.playbookKey);
      expect(netOrder).not.toEqual(candidates.map((c) => c.playbookKey));
    });

    it("scores every eligible playbook, including unattractive ones", () => {
      const candidates = estimateRecoveryCandidates(input());
      expect(candidates).toHaveLength(3);
      // Nothing is filtered out for being a poor option; that judgement is not
      // the estimator's to make.
      expect(candidates.every((c) => c.expectedGrossPaise >= 0)).toBe(true);
    });
  });
});
