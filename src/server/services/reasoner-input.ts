import "server-only";

import type {
  ReasonerCandidate,
  ReasonerOpportunity,
  ReasonerPolicyContext,
} from "@/core/reasoner";
import type { MerchantConfig } from "@/server/dataset/config";

/**
 * Assembly of the model's input.
 *
 * The single most important property of this file: it builds the prompt payload
 * from AGGREGATES and ESTIMATOR OUTPUT only. No customer id, name, masked email,
 * phone, city, or per-customer amount is ever reachable from here, so PII
 * exposure is prevented by what the function can see rather than by remembering
 * to redact.
 */

export interface EstimateRowForReasoner {
  id: string;
  playbookId: string;
  expectedGrossPaise: number;
  costPaise: number;
  discountCostPaise: number;
  channelCostPaise: number;
  gatewayFeePaise: number;
  expectedNetPaise: number;
  pRecoverAvgBps: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  estimatorVersion: string;
  playbook: {
    id: string;
    key: string;
    name: string;
    actionType: string;
    defaultDiscountBps: number;
  };
  inputsSnapshot: unknown;
}

export interface OpportunityRowForReasoner {
  id: string;
  type: string;
  affectedCustomerCount: number;
  recoverableAmountPaise: number;
  detectorVersion: string;
  evidence: unknown;
}

/** Pull the counted failure-reason breakdown out of the detector's evidence. */
function readFailureBreakdown(evidence: unknown): Record<string, number> {
  if (!evidence || typeof evidence !== "object") return {};
  const record = (evidence as Record<string, unknown>).failureReasonBreakdown;
  if (!record || typeof record !== "object") return {};

  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isInteger(value)) result[key] = value;
  }
  return result;
}

export function toReasonerOpportunity(row: OpportunityRowForReasoner): ReasonerOpportunity {
  return {
    opportunityId: row.id,
    type: row.type,
    affectedCustomerCount: row.affectedCustomerCount,
    recoverableAmountPaise: row.recoverableAmountPaise,
    failureReasonBreakdown: readFailureBreakdown(row.evidence),
    detectorVersion: row.detectorVersion,
  };
}

/** Read the discount actually used, falling back to the playbook default. */
function readDiscountBps(row: EstimateRowForReasoner): number {
  const snapshot = row.inputsSnapshot;
  if (snapshot && typeof snapshot === "object") {
    const value = (snapshot as Record<string, unknown>).discountBps;
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return row.playbook.defaultDiscountBps;
}

/**
 * Convert persisted Estimate rows into candidates.
 *
 * Every field is copied verbatim from the estimator's output. Nothing is
 * recomputed here — if this function did arithmetic, the model would be reading
 * numbers that no Estimate row could vouch for.
 */
export function toReasonerCandidates(
  rows: readonly EstimateRowForReasoner[],
): ReasonerCandidate[] {
  return rows
    .map((row) => ({
      playbookId: row.playbook.id,
      playbookKey: row.playbook.key,
      playbookName: row.playbook.name,
      actionType: row.playbook.actionType,
      expectedGrossPaise: row.expectedGrossPaise,
      costPaise: row.costPaise,
      discountCostPaise: row.discountCostPaise,
      channelCostPaise: row.channelCostPaise,
      gatewayFeePaise: row.gatewayFeePaise,
      expectedNetPaise: row.expectedNetPaise,
      pRecoverAvgBps: row.pRecoverAvgBps,
      confidence: row.confidence,
      discountBps: readDiscountBps(row),
      estimateId: row.id,
      estimatorVersion: row.estimatorVersion,
    }))
    // Alphabetical, deliberately: presenting candidates in value order would
    // put the estimator's implicit ranking in front of the model.
    .sort((a, b) => a.playbookKey.localeCompare(b.playbookKey));
}

/** Policy context the model may cite but cannot change. */
export function toReasonerPolicy(
  merchantConfig: MerchantConfig,
  merchantMode: string,
): ReasonerPolicyContext {
  const rules = merchantConfig.guardrail_policy.rules;
  const limitOf = (rule: string, fallback: number): number => {
    const value = rules[rule]?.limit;
    return typeof value === "number" ? value : fallback;
  };

  return {
    mode: merchantMode,
    currency: merchantConfig.merchant.currency,
    maxDiscountBps: limitOf("MAX_DISCOUNT_BPS", 0),
    minExpectedNetPaise: limitOf("MIN_EXPECTED_NET_PAISE", 0),
    dailyDiscountBudgetPaise: limitOf("DAILY_DISCOUNT_BUDGET_PAISE", 0),
    maxContactsPerCustomer: limitOf("MAX_CONTACTS_PER_CUSTOMER", 0),
    requiresHumanApproval: true,
    notes: [
      "Every money-affecting action requires human approval before execution.",
      "Recovery probabilities come from the merchant's configured calibration and " +
        "seeded priors, not from measured causal effect.",
      "Confidence is MEDIUM because priors carry pseudo-observations and no recorded outcomes.",
    ],
  };
}
