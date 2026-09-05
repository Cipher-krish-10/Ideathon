import "server-only";

import { failureAgeInDays } from "@/core/detectors";
import type {
  EstimateCandidate,
  EstimatorPlaybook,
  EstimatorTarget,
  PlaybookPrior,
} from "@/core/estimator";
import { ESTIMATOR_VERSION, estimateRecoveryCandidates } from "@/core/estimator";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { buildEstimatorConfig } from "@/server/config/estimator-config";
import { loadMerchantConfig } from "@/server/dataset/config";
import type { MerchantConfig } from "@/server/dataset/config";

/**
 * Application service for the deterministic estimator.
 *
 * Plumbing only, in strict order:
 *   1. load merchant configuration and calibration
 *   2. load the opportunity and its qualifying targets
 *   3. load eligible playbooks and their Beta priors
 *   4. run the PURE estimator
 *   5. persist one Estimate per (opportunity, playbook, estimator version)
 *
 * Nothing here decides anything. No scoring rule lives in this file, and no
 * winner is selected — the service persists every candidate the estimator
 * produced, exactly as produced.
 */

export interface RunEstimatorOptions {
  /** Score but write nothing. */
  dryRun?: boolean;
  /** Per-playbook discount override, keyed by playbook key. */
  discountOverridesBps?: Record<string, number>;
  client?: PrismaClient;
  config?: MerchantConfig;
}

export interface RunEstimatorResult {
  opportunityId: string;
  merchantId: string;
  estimatorVersion: string;
  targetCount: number;
  candidates: EstimateCandidate[];
  /** Estimate row ids, keyed by playbook key. Empty on a dry run. */
  estimateIdsByPlaybookKey: Record<string, string>;
  /** How many rows this run actually inserted. Zero on a repeat run. */
  created: number;
  /** How many already existed and were reused. */
  reused: number;
}

export async function runEstimatorForOpportunity(
  opportunityId: string,
  options: RunEstimatorOptions = {},
): Promise<RunEstimatorResult> {
  const db = options.client ?? prisma;

  // ---- 1. Configuration ----------------------------------------------------
  const merchantConfig = options.config ?? loadMerchantConfig();
  const estimatorConfig = buildEstimatorConfig(merchantConfig);

  // ---- 2. Opportunity and its targets -------------------------------------
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      targets: {
        include: {
          customer: { select: { id: true, sourceRef: true, tier: true } },
          transaction: { select: { id: true, sourceRef: true } },
          paymentAttempt: { select: { failureReason: true, occurredAt: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!opportunity) throw new Error(`Unknown opportunity: ${opportunityId}`);

  const merchantId = opportunity.merchantId;
  const referenceAt = opportunity.referenceAt;

  const targets: EstimatorTarget[] = opportunity.targets.map((target) => {
    const failureReason = target.paymentAttempt.failureReason;
    if (!failureReason) {
      // The detector never emits a target without an operative failure reason,
      // so this means the underlying rows changed since detection.
      throw new Error(
        `Opportunity target ${target.id} references an attempt with no failure reason`,
      );
    }
    return {
      transactionId: target.transactionId,
      transactionRef: target.transaction.sourceRef,
      customerId: target.customerId,
      customerRef: target.customer.sourceRef,
      amountPaise: target.recoverableAmountPaise,
      failureReason,
      customerTier: target.customer.tier,
      // Measured exactly as the detector measured it — one shared definition.
      failureAgeDays: failureAgeInDays(target.paymentAttempt.occurredAt, referenceAt),
    };
  });

  // ---- 3. Playbooks and priors --------------------------------------------
  const [playbookRows, priorRows] = await Promise.all([
    db.playbook.findMany({ where: { merchantId }, orderBy: { key: "asc" } }),
    db.playbookStat.findMany({
      where: { merchantId },
      include: { playbook: { select: { key: true } } },
    }),
  ]);

  const playbooks: EstimatorPlaybook[] = playbookRows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    actionType: row.actionType,
    defaultDiscountBps: row.defaultDiscountBps,
    channelCostPaise: row.channelCostPaise,
    isActive: row.isActive,
  }));

  const priors: PlaybookPrior[] = priorRows.map((row) => ({
    playbookKey: row.playbook.key,
    failureReason: row.failureReason,
    alphaMilli: row.alphaMilli,
    betaMilli: row.betaMilli,
    observationCount: row.observationCount,
  }));

  // ---- 4. Score (pure; touches nothing) -----------------------------------
  const candidates = estimateRecoveryCandidates({
    opportunityId,
    targets,
    playbooks,
    priors,
    config: estimatorConfig,
    ...(options.discountOverridesBps
      ? { discountOverridesBps: options.discountOverridesBps }
      : {}),
  });

  if (options.dryRun) {
    return {
      opportunityId,
      merchantId,
      estimatorVersion: ESTIMATOR_VERSION,
      targetCount: targets.length,
      candidates,
      estimateIdsByPlaybookKey: {},
      created: 0,
      reused: 0,
    };
  }

  // ---- 5. Persist ----------------------------------------------------------
  const persisted = await persistEstimates(db, merchantId, candidates);

  return {
    opportunityId,
    merchantId,
    estimatorVersion: ESTIMATOR_VERSION,
    targetCount: targets.length,
    candidates,
    ...persisted,
  };
}

/**
 * Write one Estimate per candidate.
 *
 * Idempotent on (opportunityId, playbookId, estimatorVersion), which is a
 * unique index. The estimator is deterministic, so a repeat run of the same
 * version has nothing new to say and the existing row is reused; a concurrent
 * double-run conflicts at the database rather than producing two scorings of
 * the same decision.
 */
async function persistEstimates(
  db: PrismaClient,
  merchantId: string,
  candidates: readonly EstimateCandidate[],
): Promise<{
  estimateIdsByPlaybookKey: Record<string, string>;
  created: number;
  reused: number;
}> {
  const estimateIdsByPlaybookKey: Record<string, string> = {};
  let created = 0;
  let reused = 0;

  for (const candidate of candidates) {
    const existing = await db.estimate.findUnique({
      where: {
        opportunityId_playbookId_estimatorVersion: {
          opportunityId: candidate.opportunityId,
          playbookId: candidate.playbookId,
          estimatorVersion: candidate.estimatorVersion,
        },
      },
    });

    if (existing) {
      estimateIdsByPlaybookKey[candidate.playbookKey] = existing.id;
      reused += 1;
      continue;
    }

    const row = await db.estimate.create({
      data: {
        merchantId,
        opportunityId: candidate.opportunityId,
        playbookId: candidate.playbookId,
        expectedGrossPaise: candidate.expectedGrossPaise,
        discountCostPaise: candidate.discountCostPaise,
        channelCostPaise: candidate.channelCostPaise,
        gatewayFeePaise: candidate.gatewayFeePaise,
        costPaise: candidate.costPaise,
        expectedNetPaise: candidate.expectedNetPaise,
        pRecoverAvgBps: candidate.pRecoverAvgBps,
        confidence: candidate.confidence,
        // Deterministic inputs only — never an LLM-generated explanation.
        inputsSnapshot: candidate.inputsSnapshot as unknown as Prisma.InputJsonObject,
        estimatorVersion: candidate.estimatorVersion,
      },
    });

    estimateIdsByPlaybookKey[candidate.playbookKey] = row.id;
    created += 1;
  }

  return { estimateIdsByPlaybookKey, created, reused };
}

export { ESTIMATOR_VERSION };
