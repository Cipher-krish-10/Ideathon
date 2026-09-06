import "server-only";

import type { GuardrailEvaluationResult } from "@/core/guardrails";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { submitForApproval } from "./approval.service";
import { runEstimatorForOpportunity } from "./estimator.service";
import { runFailedPaymentRecoveryDetector } from "./failed-payment-recovery.service";
import { runReasonerForOpportunity } from "./reasoner.service";
import type { LlmProvider } from "@/integrations/llm";

/**
 * The full agent cycle, in order:
 *
 *   OBSERVE (detector) -> REASON (estimator) -> PLAN (reasoner) -> GUARDRAIL
 *
 * and then it STOPS, at PENDING_APPROVAL or GUARDRAIL_BLOCKED. A human decides
 * what happens next; nothing downstream of this function can move money.
 *
 * Each stage is independently idempotent, so re-running "Run Agent" is safe and
 * converges on the same proposal rather than piling up duplicates.
 */
export interface AgentRunResult {
  merchantId: string;
  opportunityId: string;
  qualifyingCandidates: number;
  recoverableAmountPaise: number;
  estimatesCreated: number;
  interventionId: string | null;
  interventionState: string | null;
  reasoningMode: string | null;
  guardrail: GuardrailEvaluationResult | null;
  reusedExistingProposal: boolean;
}

export async function runAgentCycle(
  merchantId: string,
  options: { client?: PrismaClient; provider?: LlmProvider; force?: boolean } = {},
): Promise<AgentRunResult> {
  const db = options.client ?? prisma;

  // 1. OBSERVE
  const detection = await runFailedPaymentRecoveryDetector(merchantId, {
    client: db, diagnostics: true,
  });
  const opportunityId = detection.opportunityId;
  if (!opportunityId) throw new Error("Detector produced no opportunity");

  // 2. REASON — deterministic scoring, before any model is consulted
  const estimation = await runEstimatorForOpportunity(opportunityId, { client: db });

  // 3. PLAN — the model ranks the pre-scored candidates
  const reasoning = await runReasonerForOpportunity(opportunityId, {
    client: db,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.force ? { force: true } : {}),
  });

  const interventionId = reasoning.interventionId;
  if (!interventionId) {
    return {
      merchantId, opportunityId,
      qualifyingCandidates: detection.detection.candidates.length,
      recoverableAmountPaise: detection.detection.aggregate.recoverableAmountPaise,
      estimatesCreated: estimation.created,
      interventionId: null, interventionState: null, reasoningMode: null,
      guardrail: null, reusedExistingProposal: false,
    };
  }

  // 4. GUARDRAIL — only a fresh proposal is submitted; an existing one keeps
  // whatever state a human already moved it to.
  const intervention = await db.intervention.findUniqueOrThrow({
    where: { id: interventionId },
    select: { state: true },
  });

  let guardrail: GuardrailEvaluationResult | null = null;
  let state: string = intervention.state;

  if (intervention.state === "PROPOSED") {
    const submission = await submitForApproval(interventionId, { client: db });
    guardrail = submission.evaluation;
    state = submission.state;
  }

  return {
    merchantId,
    opportunityId,
    qualifyingCandidates: detection.detection.candidates.length,
    recoverableAmountPaise: detection.detection.aggregate.recoverableAmountPaise,
    estimatesCreated: estimation.created,
    interventionId,
    interventionState: state,
    reasoningMode: reasoning.proposal.reasoningMode,
    guardrail,
    reusedExistingProposal: !reasoning.created,
  };
}
