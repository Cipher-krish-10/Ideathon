/**
 * Types for the deterministic guardrail engine.
 *
 * The guardrail engine is AUTHORITATIVE. The LLM's recommendation is a
 * proposal; this layer decides whether it may proceed. Nothing here consults a
 * model, and no rule outcome is negotiable by prose.
 *
 * Pure and framework-free: every fact the rules need arrives as explicit input,
 * so the same context always yields the same decision.
 */
import { z } from "zod";

export type GuardrailPhase = "PRE_APPROVAL" | "PRE_EXECUTION";

/** Ordered least to most severe; the aggregate decision is the worst failure. */
export type GuardrailSeverity = "WARN" | "REQUIRE_APPROVAL" | "BLOCK";
export type GuardrailDecision = "PASS" | "WARN" | "REQUIRE_APPROVAL" | "BLOCK";

export const SEVERITY_RANK: Record<GuardrailDecision, number> = {
  PASS: 0,
  WARN: 1,
  REQUIRE_APPROVAL: 2,
  BLOCK: 3,
};

/** Canonical rule ids. These match the keys in merchant_config.guardrail_policy. */
export const RULE_IDS = [
  "MAX_DISCOUNT_BPS",
  "MAX_SINGLE_ACTION_EXPOSURE_PAISE",
  "DAILY_DISCOUNT_BUDGET_PAISE",
  "MIN_EXPECTED_NET_PAISE",
  "MAX_CONTACTS_PER_CUSTOMER",
  "DO_NOT_CONTACT",
  "QUIET_HOURS",
  "MAX_CONCURRENT_LIVE",
  "TEST_MODE_ONLY",
  "LOW_CONFIDENCE",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

const severitySchema = z.enum(["WARN", "REQUIRE_APPROVAL", "BLOCK"]);

/**
 * Policy shape, validated on read.
 *
 * A malformed policy must fail loudly rather than silently disabling a rule —
 * a guardrail that quietly stops running is worse than no guardrail at all,
 * because the UI would still show a reassuring green row.
 */
export const guardrailPolicyRulesSchema = z.object({
  MAX_DISCOUNT_BPS: z.object({ severity: severitySchema, limit: z.number().int().min(0) }),
  MAX_SINGLE_ACTION_EXPOSURE_PAISE: z.object({
    severity: severitySchema, limit: z.number().int().min(0),
  }),
  DAILY_DISCOUNT_BUDGET_PAISE: z.object({
    severity: severitySchema, limit: z.number().int().min(0),
  }),
  MIN_EXPECTED_NET_PAISE: z.object({
    severity: severitySchema, limit: z.number().int(),
  }),
  MAX_CONTACTS_PER_CUSTOMER: z.object({
    severity: severitySchema, limit: z.number().int().min(0),
    window_days: z.number().int().min(1),
  }),
  DO_NOT_CONTACT: z.object({ severity: severitySchema }),
  QUIET_HOURS: z.object({
    severity: severitySchema,
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(0).max(23),
  }),
  MAX_CONCURRENT_LIVE: z.object({ severity: severitySchema, limit: z.number().int().min(0) }),
  TEST_MODE_ONLY: z.object({ severity: severitySchema }),
  LOW_CONFIDENCE: z.object({
    severity: severitySchema,
    min_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  }),
});

export type GuardrailPolicyRules = z.infer<typeof guardrailPolicyRulesSchema>;

/** One customer this action would contact. */
export interface ActionTarget {
  customerId: string;
  customerRef: string;
  transactionId: string;
  amountPaise: number;
  /** Contacts already made to this customer inside the policy window. */
  recentContactCount: number;
  /** Active do-not-contact as of the evaluation instant. */
  isSuppressed: boolean;
}

/**
 * The action under evaluation.
 *
 * Every monetary field is copied from the Estimate the reasoner selected. The
 * guardrail engine never recomputes them: if it did, the numbers it judged
 * could differ from the numbers the merchant approved.
 */
export interface ProposedAction {
  interventionId: string;
  playbookId: string;
  playbookKey: string;
  discountBps: number;
  expectedGrossPaise: number;
  expectedNetPaise: number;
  discountCostPaise: number;
  costPaise: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  targets: readonly ActionTarget[];
}

/** Live state, re-read at every evaluation. */
export interface MerchantState {
  mode: string;
  timezone: string;
  /** Discount already committed across live interventions in the rolling window. */
  dailyDiscountCommittedPaise: number;
  /** Interventions currently occupying a live slot. */
  concurrentLiveCount: number;
}

export interface GuardrailContext {
  phase: GuardrailPhase;
  /** The instant to judge against. Never read from a clock inside the engine. */
  evaluatedAt: Date;
  action: ProposedAction;
  policy: GuardrailPolicyRules;
  policyVersion: number;
  state: MerchantState;
}

/**
 * One rule's verdict.
 *
 * `observed` and `limit` are carried verbatim so the UI can show the merchant
 * exactly what was measured against what — a rule that only says "failed" is
 * not an explanation.
 */
export interface RuleResult {
  ruleId: RuleId;
  severity: GuardrailSeverity;
  passed: boolean;
  observed: string | number;
  limit: string | number;
  message: string;
  /** Human-readable label for the UI. */
  label: string;
}

export interface GuardrailEvaluationResult {
  phase: GuardrailPhase;
  decision: GuardrailDecision;
  policyVersion: number;
  evaluatedAt: Date;
  results: readonly RuleResult[];
  /** Rules that failed, most severe first. */
  failures: readonly RuleResult[];
  /** True when the aggregate decision is BLOCK. */
  blocked: boolean;
}
