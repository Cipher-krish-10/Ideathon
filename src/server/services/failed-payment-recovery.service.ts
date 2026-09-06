import "server-only";

import type { DetectionResult } from "@/core/detectors";
import {
  DETECTOR_KEY,
  DETECTOR_VERSION,
  detectFailedPaymentRecovery,
} from "@/core/detectors";
import type { Prisma } from "@/generated/prisma/client";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { loadMerchantConfig } from "@/server/dataset/config";
import type { MerchantConfig } from "@/server/dataset/config";
import {
  toCustomerRecord,
  toDetectorConfig,
  toPaymentAttemptRecord,
  toTransactionRecord,
} from "./detector-input";

/**
 * Application service for the failed-payment-recovery detector.
 *
 * Its job is plumbing, in strict order:
 *   1. load merchant configuration
 *   2. read customers, transactions, and payment attempts
 *   3. convert database rows into detector input
 *   4. run the PURE detector
 *   5. persist the resulting Opportunity and OpportunityTarget rows
 *
 * The rules live in src/core/detectors. Nothing in this file decides what
 * qualifies — deliberately, so that detection logic can never drift into a
 * repository or a query where it would be invisible and untestable.
 */

export interface RunDetectorOptions {
  /** Defaults to the merchant's dataset reference instant. */
  referenceAt?: Date;
  /** Retain per-row exclusion detail. Default true — the demo needs it. */
  diagnostics?: boolean;
  /** Run detection but write nothing. */
  dryRun?: boolean;
  client?: PrismaClient;
  config?: MerchantConfig;
}

export interface RunDetectorResult {
  merchantId: string;
  detection: DetectionResult;
  /** Null on a dry run. */
  opportunityId: string | null;
  /** False when an identical run already existed and was reused. */
  created: boolean;
  targetsWritten: number;
}

export async function runFailedPaymentRecoveryDetector(
  merchantId: string,
  options: RunDetectorOptions = {},
): Promise<RunDetectorResult> {
  const db = options.client ?? prisma;
  const diagnostics = options.diagnostics ?? true;

  // ---- 1. Configuration ---------------------------------------------------
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new Error(`Unknown merchant: ${merchantId}`);

  const merchantConfig = options.config ?? loadMerchantConfig();
  const detectorConfig = toDetectorConfig(merchantConfig);

  // The dataset's "as of" instant, from the database. Recency and suppression
  // are judged against this rather than the wall clock, so a run is
  // reproducible on any day.
  const referenceAt = options.referenceAt ?? merchant.datasetReferenceAt;

  // ---- 2. Read source records ---------------------------------------------
  // Scoped by merchantId at every read. The repository retrieves; it does not
  // filter on recoverability -- that judgement belongs to the detector alone.
  const [customerRows, transactionRows, attemptRows] = await Promise.all([
    db.customer.findMany({
      where: { merchantId },
      select: {
        id: true,
        sourceRef: true,
        tier: true,
        lifetimeValuePaise: true,
        doNotContactUntil: true,
      },
    }),
    db.transaction.findMany({
      where: { merchantId },
      select: {
        id: true,
        sourceRef: true,
        customerId: true,
        amountPaise: true,
        occurredAt: true,
      },
    }),
    db.paymentAttempt.findMany({
      where: { merchantId },
      select: {
        id: true,
        sourceRef: true,
        transactionId: true,
        status: true,
        failureReason: true,
        attemptNo: true,
        occurredAt: true,
      },
    }),
  ]);

  // ---- 3. Convert to detector input ---------------------------------------
  const detection = detectFailedPaymentRecovery(
    {
      referenceAt,
      config: detectorConfig,
      customers: customerRows.map(toCustomerRecord),
      transactions: transactionRows.map(toTransactionRecord),
      paymentAttempts: attemptRows.map(toPaymentAttemptRecord),
    },
    { diagnostics },
  );
  // ---- 4. (the detector ran; it touched nothing) --------------------------

  if (options.dryRun) {
    return {
      merchantId,
      detection,
      opportunityId: null,
      created: false,
      targetsWritten: 0,
    };
  }

  // ---- 5. Persist ----------------------------------------------------------
  const persisted = await persistDetection(db, merchantId, detection);
  return { merchantId, detection, ...persisted };
}

/**
 * Write the Opportunity and its targets.
 *
 * Idempotent on (merchantId, detectorKey, detectorVersion, referenceAt). A
 * re-run of the same detector version against the same instant reuses the
 * existing row rather than creating a second one — the detector is
 * deterministic, so a repeat run has nothing new to say. The same tuple is a
 * unique index in the database, so a concurrent double-run conflicts instead of
 * silently double-counting recoverable revenue.
 */
async function persistDetection(
  db: PrismaClient,
  merchantId: string,
  detection: DetectionResult,
): Promise<{ opportunityId: string; created: boolean; targetsWritten: number }> {
  const runKey = {
    merchantId_detectorKey_detectorVersion_referenceAt: {
      merchantId,
      detectorKey: detection.detectorKey,
      detectorVersion: detection.detectorVersion,
      referenceAt: detection.referenceAt,
    },
  };

  const existing = await db.opportunity.findUnique({
    where: runKey,
    include: { _count: { select: { targets: true } } },
  });
  if (existing) {
    return {
      opportunityId: existing.id,
      created: false,
      targetsWritten: existing._count.targets,
    };
  }

  return db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.create({
      data: {
        merchantId,
        type: "FAILED_PAYMENT_RECOVERY",
        status: "OPEN",
        detectorKey: detection.detectorKey,
        detectorVersion: detection.detectorVersion,
        // Counted evidence only. Not a projection anywhere in here.
        affectedCustomerCount: detection.aggregate.affectedCustomerCount,
        recoverableAmountPaise: detection.aggregate.recoverableAmountPaise,
        evidence: buildEvidence(detection),
        referenceAt: detection.referenceAt,
      },
    });

    // OpportunityTarget is unique on [opportunityId, transactionId], so
    // duplicate targets are impossible even if this ever ran twice.
    if (detection.candidates.length > 0) {
      await tx.opportunityTarget.createMany({
        data: detection.candidates.map((candidate) => ({
          opportunityId: opportunity.id,
          customerId: candidate.customerId,
          transactionId: candidate.transactionId,
          // The specific failed attempt the decision rests on.
          paymentAttemptId: candidate.operativeAttemptId,
          recoverableAmountPaise: candidate.amountPaise,
        })),
      });
    }

    // Audited so the activity feed's opening line is a real recorded event
    // rather than something the UI asserts happened.
    await appendAuditEntry(tx, {
      merchantId,
      actorType: "AGENT",
      entityType: "Opportunity",
      entityId: opportunity.id,
      action: "OPPORTUNITY_DETECTED",
      after: {
        detectorVersion: detection.detectorVersion,
        transactionsScanned: detection.scan.transactionsScanned,
        unpaidTransactions: detection.scan.unpaidTransactions,
        qualifyingCount: detection.aggregate.qualifyingTransactionCount,
        affectedCustomerCount: detection.aggregate.affectedCustomerCount,
        recoverableAmountPaise: detection.aggregate.recoverableAmountPaise,
      },
    });

    return {
      opportunityId: opportunity.id,
      created: true,
      targetsWritten: detection.candidates.length,
    };
  });
}

/**
 * The evidence blob stored on the Opportunity.
 *
 * Holds what was counted and what was rejected, so the decision packet can show
 * that the agent discriminated rather than merely counted failed payments.
 */
function buildEvidence(detection: DetectionResult): Prisma.InputJsonObject {
  return {
    detectorKey: detection.detectorKey,
    detectorVersion: detection.detectorVersion,
    referenceAt: detection.referenceAt.toISOString(),
    recencyCutoff: detection.recencyCutoff.toISOString(),
    scan: { ...detection.scan },
    failureReasonBreakdown: { ...detection.aggregate.failureReasonBreakdown },
    tierBreakdown: { ...detection.aggregate.tierBreakdown },
    exclusionCounts: { ...detection.exclusionCounts },
    qualifyingTransactionCount: detection.aggregate.qualifyingTransactionCount,
  };
}

export { DETECTOR_KEY, DETECTOR_VERSION };
