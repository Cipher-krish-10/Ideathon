import "server-only";

import { prisma } from "@/server/db";
import { verifyAuditChain } from "@/server/audit/audit-logger";

/**
 * Read models for the UI and the read APIs.
 *
 * These shape database rows into exactly what a screen needs. Two rules:
 *
 *   1. No raw database JSON reaches the merchant. Snapshots and evidence blobs
 *      are unpacked into named fields here.
 *   2. No customer PII leaves this layer. Screens show dataset references and
 *      tiers, never an email or a phone number, because nothing on these pages
 *      needs one.
 */

export async function listOpportunities(merchantId: string) {
  const opportunities = await prisma.opportunity.findMany({
    where: { merchantId },
    orderBy: { detectedAt: "desc" },
    include: {
      _count: { select: { targets: true, estimates: true, interventions: true } },
    },
  });

  return opportunities.map((opportunity) => ({
    id: opportunity.id,
    type: opportunity.type,
    status: opportunity.status,
    detectorVersion: opportunity.detectorVersion,
    affectedCustomerCount: opportunity.affectedCustomerCount,
    recoverableAmountPaise: opportunity.recoverableAmountPaise,
    targetCount: opportunity._count.targets,
    estimateCount: opportunity._count.estimates,
    interventionCount: opportunity._count.interventions,
    detectedAt: opportunity.detectedAt.toISOString(),
    referenceAt: opportunity.referenceAt.toISOString(),
    failureReasonBreakdown: readBreakdown(opportunity.evidence),
    exclusionCounts: readExclusions(opportunity.evidence),
  }));
}

export async function getOpportunityDetail(merchantId: string, opportunityId: string) {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, merchantId },
    include: {
      targets: {
        include: {
          customer: { select: { sourceRef: true, tier: true, lifetimeValuePaise: true } },
          transaction: { select: { sourceRef: true, amountPaise: true, occurredAt: true } },
          paymentAttempt: { select: { failureReason: true, attemptNo: true, occurredAt: true } },
        },
        orderBy: { recoverableAmountPaise: "desc" },
      },
      estimates: {
        include: { playbook: { select: { key: true, name: true } } },
        orderBy: { expectedNetPaise: "desc" },
      },
      interventions: {
        select: { id: true, state: true, reasoningMode: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!opportunity) return null;

  return {
    id: opportunity.id,
    type: opportunity.type,
    status: opportunity.status,
    detectorVersion: opportunity.detectorVersion,
    affectedCustomerCount: opportunity.affectedCustomerCount,
    recoverableAmountPaise: opportunity.recoverableAmountPaise,
    detectedAt: opportunity.detectedAt.toISOString(),
    referenceAt: opportunity.referenceAt.toISOString(),
    failureReasonBreakdown: readBreakdown(opportunity.evidence),
    exclusionCounts: readExclusions(opportunity.evidence),
    scan: readScan(opportunity.evidence),
    // Dataset references and tier only -- never contact details.
    targets: opportunity.targets.map((target) => ({
      customerRef: target.customer.sourceRef,
      customerTier: target.customer.tier,
      customerLifetimeValuePaise: target.customer.lifetimeValuePaise,
      transactionRef: target.transaction.sourceRef,
      amountPaise: target.recoverableAmountPaise,
      failureReason: target.paymentAttempt.failureReason,
      failedAttemptNo: target.paymentAttempt.attemptNo,
      failedAt: target.paymentAttempt.occurredAt.toISOString(),
    })),
    estimates: opportunity.estimates.map(toEstimateSummary),
    interventions: opportunity.interventions.map((intervention) => ({
      id: intervention.id,
      state: intervention.state,
      reasoningMode: intervention.reasoningMode,
      createdAt: intervention.createdAt.toISOString(),
    })),
  };
}

export async function listInterventions(merchantId: string, state?: string) {
  const interventions = await prisma.intervention.findMany({
    where: { merchantId, ...(state ? { state: state as never } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      playbook: { select: { key: true, name: true } },
      estimate: { select: { expectedNetPaise: true, confidence: true } },
      _count: { select: { targets: true } },
    },
  });

  return interventions.map((intervention) => ({
    id: intervention.id,
    state: intervention.state,
    reasoningMode: intervention.reasoningMode,
    playbookKey: intervention.playbook.key,
    playbookName: intervention.playbook.name,
    expectedNetPaise: intervention.estimate.expectedNetPaise,
    confidence: intervention.estimate.confidence,
    targetCount: intervention._count.targets,
    version: intervention.version,
    createdAt: intervention.createdAt.toISOString(),
    expiresAt: intervention.expiresAt?.toISOString() ?? null,
  }));
}

/**
 * The decision packet.
 *
 * Everything a merchant needs to decide, assembled once: what was found, what
 * the agent chose, what it did NOT choose, what was checked, and what would be
 * sent.
 */
export async function getDecisionPacket(merchantId: string, interventionId: string) {
  const intervention = await prisma.intervention.findFirst({
    where: { id: interventionId, merchantId },
    include: {
      merchant: { select: { mode: true, timezone: true } },
      playbook: { select: { id: true, key: true, name: true, actionType: true } },
      estimate: { include: { playbook: { select: { key: true, name: true } } } },
      opportunity: {
        select: {
          id: true, affectedCustomerCount: true, recoverableAmountPaise: true,
          evidence: true, detectorVersion: true, detectedAt: true,
        },
      },
      guardrailEvaluations: { orderBy: { evaluatedAt: "asc" } },
      razorpayArtifacts: { orderBy: { createdAt: "asc" } },
      executionAttempts: { orderBy: { attemptNo: "asc" } },
      approval: { include: { user: { select: { name: true, email: true, role: true } } } },
      _count: { select: { targets: true } },
    },
  });
  if (!intervention) return null;

  const [alternatives, llmCalls, auditEntries] = await Promise.all([
    prisma.estimate.findMany({
      where: {
        opportunityId: intervention.opportunityId,
        estimatorVersion: intervention.estimate.estimatorVersion,
      },
      include: { playbook: { select: { key: true, name: true } } },
      orderBy: { expectedNetPaise: "desc" },
    }),
    prisma.llmCall.findMany({
      where: { interventionId },
      orderBy: { attemptNo: "asc" },
      select: {
        id: true, provider: true, model: true, attemptNo: true, isValid: true,
        validationOutcome: true, latencyMs: true, createdAt: true, validationResult: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        merchantId,
        OR: [
          { entityType: "Intervention", entityId: interventionId },
          { entityType: "Approval", entityId: intervention.approval?.id ?? "__none__" },
        ],
      },
      orderBy: { seq: "asc" },
    }),
  ]);

  const message = (intervention.customerMessage ?? {}) as Record<string, unknown>;

  return {
    id: intervention.id,
    state: intervention.state,
    version: intervention.version,
    reasoningMode: intervention.reasoningMode,
    mode: intervention.merchant.mode,
    timezone: intervention.merchant.timezone,
    createdAt: intervention.createdAt.toISOString(),
    proposedAt: intervention.proposedAt?.toISOString() ?? null,
    approvedAt: intervention.approvedAt?.toISOString() ?? null,
    expiresAt: intervention.expiresAt?.toISOString() ?? null,
    targetCount: intervention._count.targets,

    opportunity: {
      id: intervention.opportunity.id,
      affectedCustomerCount: intervention.opportunity.affectedCustomerCount,
      recoverableAmountPaise: intervention.opportunity.recoverableAmountPaise,
      detectorVersion: intervention.opportunity.detectorVersion,
      detectedAt: intervention.opportunity.detectedAt.toISOString(),
      failureReasonBreakdown: readBreakdown(intervention.opportunity.evidence),
      exclusionCounts: readExclusions(intervention.opportunity.evidence),
    },

    recommendation: {
      playbookId: intervention.playbook.id,
      playbookKey: intervention.playbook.key,
      playbookName: intervention.playbook.name,
      actionType: intervention.playbook.actionType,
      rationale: intervention.rationale,
      risksIdentified: Array.isArray(message.risksIdentified)
        ? (message.risksIdentified as string[])
        : [],
      confidenceNote: typeof message.confidenceNote === "string" ? message.confidenceNote : null,
      estimate: toEstimateSummary(intervention.estimate),
    },

    alternatives: alternatives.map((estimate) => ({
      ...toEstimateSummary(estimate),
      isSelected: estimate.id === intervention.estimateId,
    })),

    guardrails: intervention.guardrailEvaluations.map((evaluation) => ({
      id: evaluation.id,
      phase: evaluation.phase,
      decision: evaluation.decision,
      policyVersion: evaluation.policyVersion,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      results: readRuleResults(evaluation.ruleResults),
    })),

    customerMessage: {
      subject: typeof message.subject === "string" ? message.subject : "",
      body: typeof message.body === "string" ? message.body : "",
      originalSubject: typeof message.originalSubject === "string" ? message.originalSubject : null,
      originalBody: typeof message.originalBody === "string" ? message.originalBody : null,
      editedAt: typeof message.editedAt === "string" ? message.editedAt : null,
    },

    // "created" is the LINK's status. It is not payment, and not recovery.
    execution: {
      artifacts: intervention.razorpayArtifacts.map((artifact) => ({
        id: artifact.id,
        providerEntityId: artifact.providerEntityId,
        shortUrl: artifact.shortUrl,
        amountPaise: artifact.amountPaise,
        status: artifact.status,
        createdAt: artifact.createdAt.toISOString(),
      })),
      attempts: intervention.executionAttempts.map((attempt) => ({
        attemptNo: attempt.attemptNo,
        status: attempt.status,
        responseStatus: attempt.responseStatus,
        error: attempt.error,
        // Truncated: enough to prove idempotency without printing a whole hash.
        idempotencyKey: `${attempt.idempotencyKey.slice(0, 12)}…`,
        startedAt: attempt.startedAt.toISOString(),
      })),
      totalAmountPaise: intervention.razorpayArtifacts.reduce(
        (sum, artifact) => sum + artifact.amountPaise, 0,
      ),
    },

    approval: intervention.approval
      ? {
          decision: intervention.approval.decision,
          note: intervention.approval.note,
          decidedAt: intervention.approval.decidedAt.toISOString(),
          approver: intervention.approval.user.name,
          approverRole: intervention.approval.user.role,
        }
      : null,

    reasoning: llmCalls.map((call) => ({
      id: call.id,
      provider: call.provider,
      model: call.model,
      attemptNo: call.attemptNo,
      isValid: call.isValid,
      outcome: call.validationOutcome,
      latencyMs: call.latencyMs,
      createdAt: call.createdAt.toISOString(),
      issues: readIssues(call.validationResult),
    })),

    auditTimeline: auditEntries.map((entry) => ({
      seq: Number(entry.seq),
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/** Dashboard counters. Potential value is never presented as recovered. */
export async function getDashboardMetrics(merchantId: string) {
  const [
    openOpportunities, pendingApprovals, approved, blocked, rejected,
    opportunityTotals, attributed, auditChain, executedInterventions,
    artifactTotals, expectedNet,
  ] = await Promise.all([
    prisma.opportunity.count({ where: { merchantId, status: "OPEN" } }),
    prisma.intervention.count({ where: { merchantId, state: "PENDING_APPROVAL" } }),
    prisma.intervention.count({ where: { merchantId, state: "APPROVED" } }),
    prisma.intervention.count({ where: { merchantId, state: "GUARDRAIL_BLOCKED" } }),
    prisma.intervention.count({ where: { merchantId, state: "REJECTED" } }),
    prisma.opportunity.aggregate({
      where: { merchantId, status: "OPEN" },
      _sum: { recoverableAmountPaise: true, affectedCustomerCount: true },
    }),
    prisma.attributionRecord.aggregate({
      where: { merchantId }, _sum: { attributedAmountPaise: true },
    }),
    verifyAuditChain(prisma, merchantId),
    prisma.intervention.count({
      where: { merchantId, state: { in: ["EXECUTED", "OBSERVING", "CONVERTED", "NOT_CONVERTED", "LEARNED"] } },
    }),
    prisma.razorpayArtifact.aggregate({
      where: { merchantId }, _sum: { amountPaise: true }, _count: { _all: true },
    }),
    prisma.estimate.aggregate({
      where: { merchantId, interventions: { some: { state: { in: ["APPROVED", "EXECUTING", "EXECUTED", "OBSERVING"] } } } },
      _sum: { expectedNetPaise: true },
    }),
  ]);

  return {
    openOpportunities,
    pendingApprovals,
    approvedInterventions: approved,
    blockedInterventions: blocked,
    rejectedInterventions: rejected,
    // POTENTIAL, not realised. Labelled as such everywhere it is shown.
    recoverableAmountPaise: opportunityTotals._sum.recoverableAmountPaise ?? 0,
    qualifyingCustomers: opportunityTotals._sum.affectedCustomerCount ?? 0,
    // Actions actually created at the provider. NOT revenue.
    executedInterventions,
    paymentLinksCreated: artifactTotals._count._all,
    paymentLinkValuePaise: artifactTotals._sum.amountPaise ?? 0,
    // A projection from the estimator, on approved-or-later interventions.
    expectedNetPaise: expectedNet._sum.expectedNetPaise ?? 0,
    // REALISED revenue. Sourced only from AttributionRecord, which is written
    // by the attribution phase from real payment events. Creating a payment
    // link does not move this, and neither does approving one.
    recoveredAmountPaise: attributed._sum.attributedAmountPaise ?? 0,
    auditVerified: auditChain.valid,
    auditEntryCount: auditChain.entryCount,
  };
}

export async function listAuditEntries(merchantId: string, limit = 100) {
  const entries = await prisma.auditLog.findMany({
    where: { merchantId }, orderBy: { seq: "desc" }, take: limit,
  });
  const chain = await verifyAuditChain(prisma, merchantId);
  return {
    verified: chain.valid,
    entryCount: chain.entryCount,
    entries: entries.map((entry) => ({
      seq: Number(entry.seq),
      actorType: entry.actorType,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      createdAt: entry.createdAt.toISOString(),
      hash: entry.hash.slice(0, 12),
    })),
  };
}

// ---------------------------------------------------------------------------
// Unpacking stored JSON into named fields, so no raw blob reaches a screen.
// ---------------------------------------------------------------------------

function toEstimateSummary(estimate: {
  id: string; expectedGrossPaise: number; costPaise: number; discountCostPaise: number;
  channelCostPaise: number; gatewayFeePaise: number; expectedNetPaise: number;
  pRecoverAvgBps: number; confidence: string; estimatorVersion: string;
  inputsSnapshot: unknown; playbook: { key: string; name: string };
}) {
  const snapshot = (estimate.inputsSnapshot ?? {}) as Record<string, unknown>;
  return {
    estimateId: estimate.id,
    playbookKey: estimate.playbook.key,
    playbookName: estimate.playbook.name,
    expectedGrossPaise: estimate.expectedGrossPaise,
    costPaise: estimate.costPaise,
    discountCostPaise: estimate.discountCostPaise,
    channelCostPaise: estimate.channelCostPaise,
    gatewayFeePaise: estimate.gatewayFeePaise,
    expectedNetPaise: estimate.expectedNetPaise,
    pRecoverAvgBps: estimate.pRecoverAvgBps,
    confidence: estimate.confidence,
    estimatorVersion: estimate.estimatorVersion,
    discountBps: typeof snapshot.discountBps === "number" ? snapshot.discountBps : 0,
  };
}

function readBreakdown(evidence: unknown): Record<string, number> {
  return readNumberRecord(evidence, "failureReasonBreakdown");
}

function readExclusions(evidence: unknown): Record<string, number> {
  return readNumberRecord(evidence, "exclusionCounts");
}

function readScan(evidence: unknown): Record<string, number> {
  return readNumberRecord(evidence, "scan");
}

function readNumberRecord(source: unknown, key: string): Record<string, number> {
  if (!source || typeof source !== "object") return {};
  const nested = (source as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
    if (typeof v === "number") result[k] = v;
  }
  return result;
}

export interface RuleResultView {
  ruleId: string; label: string; severity: string; passed: boolean;
  observed: string; limit: string; message: string;
}

function readRuleResults(source: unknown): RuleResultView[] {
  if (!source || typeof source !== "object") return [];
  const results = (source as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      ruleId: String(row.ruleId ?? ""),
      label: String(row.label ?? row.ruleId ?? ""),
      severity: String(row.severity ?? ""),
      passed: Boolean(row.passed),
      observed: String(row.observed ?? ""),
      limit: String(row.limit ?? ""),
      message: String(row.message ?? ""),
    };
  });
}

function readIssues(source: unknown): { field: string; message: string }[] {
  if (!source || typeof source !== "object") return [];
  const issues = (source as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((entry) => {
    const row = entry as Record<string, unknown>;
    return { field: String(row.field ?? ""), message: String(row.message ?? "") };
  });
}
