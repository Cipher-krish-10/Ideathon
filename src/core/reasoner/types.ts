/**
 * Types for the LLM reasoning layer.
 *
 * THE GOVERNING RULE: the model is NON-AUTHORITATIVE. It ranks candidates the
 * deterministic estimator already scored, and explains the trade-off. It never
 * produces a number that reaches the ledger.
 *
 * That promise is structural, not a matter of prompt wording:
 *   - the output schema has NO numeric field at all, so there is nowhere for an
 *     invented figure to live;
 *   - `selectedPlaybookId` is validated against the supplied candidate set;
 *   - every number appearing in prose is checked against supplied values.
 */
import { z } from "zod";

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";
export type ReasoningMode = "LLM" | "DETERMINISTIC_FALLBACK";

/**
 * One pre-scored candidate, exactly as the estimator produced it.
 *
 * Every monetary field is integer paise, and every one of them is a value the
 * estimator computed. Nothing here originates with the model.
 */
export interface ReasonerCandidate {
  playbookId: string;
  playbookKey: string;
  playbookName: string;
  actionType: string;
  expectedGrossPaise: number;
  costPaise: number;
  discountCostPaise: number;
  channelCostPaise: number;
  gatewayFeePaise: number;
  expectedNetPaise: number;
  pRecoverAvgBps: number;
  confidence: ConfidenceLevel;
  discountBps: number;
  estimateId: string;
  estimatorVersion: string;
}

/** Aggregate opportunity facts. No customer identifiers, ever. */
export interface ReasonerOpportunity {
  opportunityId: string;
  type: string;
  affectedCustomerCount: number;
  recoverableAmountPaise: number;
  failureReasonBreakdown: Readonly<Record<string, number>>;
  detectorVersion: string;
}

/** Merchant constraints the model must respect but may not alter. */
export interface ReasonerPolicyContext {
  mode: string;
  currency: string;
  maxDiscountBps: number;
  minExpectedNetPaise: number;
  dailyDiscountBudgetPaise: number;
  maxContactsPerCustomer: number;
  requiresHumanApproval: boolean;
  notes: readonly string[];
}

/**
 * Free text of uncertain origin — merchant notes, support snippets, anything
 * that ultimately traces to a human typing. Fenced off in the prompt and
 * labelled as data. Optional, and empty in the normal path.
 */
export interface UntrustedContext {
  label: string;
  text: string;
}

export interface ReasonerInput {
  opportunity: ReasonerOpportunity;
  candidates: readonly ReasonerCandidate[];
  policy: ReasonerPolicyContext;
  untrusted?: readonly UntrustedContext[];
}

/**
 * The model's output contract.
 *
 * Deliberately contains NO numeric field. The model cannot state an amount, a
 * probability, a cost, or a discount in structured form — only prose, which is
 * then checked against the supplied values.
 */
export const llmDecisionSchema = z
  .object({
    selectedPlaybookId: z.string().min(1),
    rationale: z.string().min(20).max(2_000),
    customerMessage: z.object({
      subject: z.string().min(3).max(200),
      body: z.string().min(20).max(2_000),
    }),
    risksIdentified: z.array(z.string().min(3).max(400)).min(1).max(6),
    confidenceNote: z.string().min(10).max(600),
  })
  .strict();

export type LlmDecision = z.infer<typeof llmDecisionSchema>;

/** Why a response was rejected. Mirrors the LlmValidationOutcome enum. */
export type ValidationOutcome =
  | "VALID"
  | "EMPTY_RESPONSE"
  | "MALFORMED_JSON"
  | "SCHEMA_INVALID"
  | "UNKNOWN_PLAYBOOK"
  | "NUMERIC_HALLUCINATION"
  | "UNSUPPORTED_MESSAGE_CLAIM"
  | "CONFIDENCE_OVERCLAIM"
  | "PROVIDER_ERROR";

export interface ValidationIssue {
  outcome: ValidationOutcome;
  field: string;
  message: string;
  /** The offending token, for the audit trail and the repair prompt. */
  observed?: string;
}

export type ValidationResult =
  | { ok: true; decision: LlmDecision; issues: readonly [] }
  | { ok: false; outcome: ValidationOutcome; issues: readonly ValidationIssue[] };

/** The reasoner's final answer, however it was reached. */
export interface ReasonedProposal {
  selectedPlaybookId: string;
  selectedCandidate: ReasonerCandidate;
  rationale: string;
  customerMessage: { subject: string; body: string };
  risksIdentified: readonly string[];
  confidenceNote: string;
  reasoningMode: ReasoningMode;
  /** Every attempt made, valid or not — the audit trail of the decision. */
  attempts: readonly ReasoningAttempt[];
}

export interface ReasoningAttempt {
  attemptNo: number;
  kind: "INITIAL" | "REPAIR";
  prompt: string;
  rawResponse: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  outcome: ValidationOutcome;
  isValid: boolean;
  issues: readonly ValidationIssue[];
  parsedOutput: LlmDecision | null;
  errorMessage?: string;
}
