/**
 * Validation of model output. This is where "the LLM is non-authoritative"
 * stops being a claim in a prompt and becomes something enforced.
 *
 * Five gates, in order:
 *   1. non-empty response
 *   2. parseable JSON
 *   3. schema-valid, strictly
 *   4. selectedPlaybookId is one of the supplied candidates
 *   5. every number in prose corresponds to a supplied value
 *
 * Gate 5 is the interesting one. The output schema has no numeric field, so a
 * fabricated figure can only appear inside prose — and prose is exactly where
 * a reader would believe it.
 */
import {
  llmDecisionSchema,
  type LlmDecision,
  type ReasonerCandidate,
  type ReasonerInput,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

/**
 * A number the model is permitted to state, with the forms it may take.
 * `value` is the canonical magnitude; `kind` decides how it may be written.
 */
interface AllowedValue {
  value: number;
  kind: "currency" | "percent" | "count";
  label: string;
}

const LAKH = 100_000;
const CRORE = 10_000_000;

/**
 * Numbers, with optional currency marker, Indian digit grouping, decimals, a
 * percent sign, or a lakh/crore scale word. Deliberately greedy: anything that
 * could read as a quantity should be caught and checked.
 */
const NUMERIC_TOKEN =
  /(₹|Rs\.?|INR)?\s*(\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|lakh|lakhs|lac|crore|crores|cr\b|bps)?/gi;

/** Phrases that overstate what a seeded prior can support. */
const EVIDENCE_OVERCLAIM =
  /\b(guarantee[ds]?|guaranteed|proven|proves|historically proven|certain to|will definitely|risk-free)\b/i;

/** Claims of historical evidence we have not supplied. */
const HISTORICAL_OVERCLAIM =
  /\bhistorical(?:ly)?\s+(?:data|evidence|results?)\s+(?:prove[sd]?|show[sn]?|confirm[sed]*|demonstrate[sd]?)\b/i;

/** Assertions of high confidence. */
const HIGH_CONFIDENCE_CLAIM =
  /\b(high(?:ly)?\s+confiden(?:ce|t)|very\s+confident|strong\s+confidence)\b/i;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Build the set of values the model may quote.
 *
 * Every entry traces to a deterministic figure: an estimator output or a
 * counted fact from the detector. Nothing is added for the model's convenience.
 */
export function buildAllowedValues(input: ReasonerInput): AllowedValue[] {
  const allowed: AllowedValue[] = [];
  // Rupees only. Admitting the raw paise form as well would let a claim in
  // rupees collide with a different value's paise form -- "₹99,999.99" would
  // match a supplied 100000 paise (₹1,000) and slip through. The prompt shows
  // rupees, so the model has no reason to quote paise.
  const currency = (paise: number, label: string) => {
    allowed.push({ value: round(paise / 100, 2), kind: "currency", label });
  };

  currency(input.opportunity.recoverableAmountPaise, "opportunity.recoverableAmount");
  allowed.push({
    value: input.opportunity.affectedCustomerCount,
    kind: "count",
    label: "opportunity.affectedCustomerCount",
  });
  for (const [reason, count] of Object.entries(input.opportunity.failureReasonBreakdown)) {
    allowed.push({ value: count, kind: "count", label: `failureReason.${reason}` });
  }

  for (const candidate of input.candidates) {
    const key = candidate.playbookKey;
    currency(candidate.expectedGrossPaise, `${key}.expectedGross`);
    currency(candidate.costPaise, `${key}.cost`);
    currency(candidate.expectedNetPaise, `${key}.expectedNet`);
    currency(candidate.discountCostPaise, `${key}.discountCost`);
    currency(candidate.channelCostPaise, `${key}.channelCost`);
    currency(candidate.gatewayFeePaise, `${key}.gatewayFee`);
    allowed.push({
      value: round(candidate.pRecoverAvgBps / 100, 2),
      kind: "percent",
      label: `${key}.pRecoverAvg`,
    });
    allowed.push({ value: candidate.pRecoverAvgBps, kind: "count", label: `${key}.pRecoverAvgBps` });
    allowed.push({
      value: round(candidate.discountBps / 100, 2),
      kind: "percent",
      label: `${key}.discount`,
    });
  }

  // Policy limits the model is told about, so it may cite them.
  currency(input.policy.minExpectedNetPaise, "policy.minExpectedNet");
  currency(input.policy.dailyDiscountBudgetPaise, "policy.dailyDiscountBudget");
  allowed.push({
    value: round(input.policy.maxDiscountBps / 100, 2),
    kind: "percent",
    label: "policy.maxDiscount",
  });
  allowed.push({
    value: input.policy.maxContactsPerCustomer,
    kind: "count",
    label: "policy.maxContactsPerCustomer",
  });

  // Ordinals, so "option 2" or "all 3 candidates" is not treated as a claim.
  for (let i = 0; i <= input.candidates.length; i += 1) {
    allowed.push({ value: i, kind: "count", label: "ordinal" });
  }

  return allowed;
}

interface DetectedNumber {
  raw: string;
  value: number;
  kind: "currency" | "percent" | "count";
}

/** Pull every quantity out of a piece of prose. */
export function detectNumbers(text: string): DetectedNumber[] {
  const found: DetectedNumber[] = [];
  for (const match of text.matchAll(NUMERIC_TOKEN)) {
    const [, currencyMark, digits, suffix] = match;
    if (!digits) continue;

    const numeric = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(numeric)) continue;

    const unit = suffix?.toLowerCase() ?? "";
    let value = numeric;
    let kind: DetectedNumber["kind"] = "count";

    if (unit === "%" || unit === "percent" || unit === "per cent") {
      kind = "percent";
    } else if (unit === "bps") {
      kind = "count";
    } else if (unit.startsWith("lakh") || unit === "lac") {
      value = numeric * LAKH;
      kind = "currency";
    } else if (unit.startsWith("crore") || unit === "cr") {
      value = numeric * CRORE;
      kind = "currency";
    } else if (currencyMark) {
      kind = "currency";
    }

    found.push({ raw: match[0]!.trim(), value, kind });
  }
  return found;
}

/**
 * Does a stated number correspond to a supplied one?
 *
 * A rounded restatement is accepted — "roughly 49%" for 49.26% is honest
 * shorthand, and rejecting it would make the system brittle without making it
 * safer. What is refused is a DIFFERENT number: the model may state a supplied
 * value less precisely, never a value it was not given.
 */
function matchesAllowed(detected: DetectedNumber, allowed: readonly AllowedValue[]): boolean {
  for (const candidate of allowed) {
    // Currency may be quoted as a bare number; a percent must stay a percent.
    const kindCompatible =
      detected.kind === candidate.kind ||
      (detected.kind === "count" && candidate.kind === "currency") ||
      (detected.kind === "currency" && candidate.kind === "count");
    if (!kindCompatible) continue;

    for (const digits of [2, 1, 0]) {
      if (round(detected.value, digits) === round(candidate.value, digits)) return true;
    }
  }
  return false;
}

function checkProse(
  text: string,
  field: string,
  allowed: readonly AllowedValue[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const detected of detectNumbers(text)) {
    if (!matchesAllowed(detected, allowed)) {
      issues.push({
        outcome: "NUMERIC_HALLUCINATION",
        field,
        message:
          `"${detected.raw}" does not correspond to any value supplied by the ` +
          "deterministic estimator.",
        observed: detected.raw,
      });
    }
  }

  if (EVIDENCE_OVERCLAIM.test(text)) {
    issues.push({
      outcome: "CONFIDENCE_OVERCLAIM",
      field,
      message:
        "States a guarantee or proof. The recovery model is configured calibration, " +
        "not measured causal effect.",
      observed: text.match(EVIDENCE_OVERCLAIM)?.[0] ?? "",
    });
  }

  if (HISTORICAL_OVERCLAIM.test(text)) {
    issues.push({
      outcome: "CONFIDENCE_OVERCLAIM",
      field,
      message: "Claims historical evidence that was not supplied.",
      observed: text.match(HISTORICAL_OVERCLAIM)?.[0] ?? "",
    });
  }

  return issues;
}

/**
 * Customer-facing copy is held to a stricter rule than internal prose.
 *
 * The reasoner works on AGGREGATES; it is never told what any individual owes.
 * A concrete rupee amount in a customer message is therefore fabricated by
 * definition. Only the selected playbook's discount may be quoted; per-customer
 * figures belong in placeholders that the executor fills in later.
 */
function checkCustomerMessage(
  message: { subject: string; body: string },
  selected: ReasonerCandidate,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const discountPercent = round(selected.discountBps / 100, 2);

  for (const [field, text] of [
    ["customerMessage.subject", message.subject],
    ["customerMessage.body", message.body],
  ] as const) {
    for (const detected of detectNumbers(text)) {
      // Plain counts ("valid for 7 days") are not financial promises.
      if (detected.kind === "count") continue;

      if (detected.kind === "percent") {
        if (selected.discountBps > 0 && round(detected.value, 2) === discountPercent) continue;
        issues.push({
          outcome: "UNSUPPORTED_MESSAGE_CLAIM",
          field,
          message:
            selected.discountBps > 0
              ? `Offers ${detected.raw}, but the selected playbook's discount is ${discountPercent}%.`
              : `Offers ${detected.raw}, but the selected playbook carries no discount.`,
          observed: detected.raw,
        });
        continue;
      }

      issues.push({
        outcome: "UNSUPPORTED_MESSAGE_CLAIM",
        field,
        message:
          `Quotes a monetary amount (${detected.raw}). Customer copy is drafted from ` +
          "aggregates and must use a placeholder for any per-customer figure.",
        observed: detected.raw,
      });
    }

    if (EVIDENCE_OVERCLAIM.test(text)) {
      issues.push({
        outcome: "UNSUPPORTED_MESSAGE_CLAIM",
        field,
        message: "Makes a guarantee to the customer.",
        observed: text.match(EVIDENCE_OVERCLAIM)?.[0] ?? "",
      });
    }
  }

  return issues;
}

/** The model may not claim more confidence than the estimator assigned. */
function checkConfidence(
  decision: LlmDecision,
  selected: ReasonerCandidate,
): ValidationIssue[] {
  if (selected.confidence === "HIGH") return [];

  const issues: ValidationIssue[] = [];
  for (const [field, text] of [
    ["rationale", decision.rationale],
    ["confidenceNote", decision.confidenceNote],
  ] as const) {
    if (HIGH_CONFIDENCE_CLAIM.test(text)) {
      issues.push({
        outcome: "CONFIDENCE_OVERCLAIM",
        field,
        message:
          `Asserts high confidence, but the estimator assigned ${selected.confidence}. ` +
          "Priors carry pseudo-observations and no recorded outcomes.",
        observed: text.match(HIGH_CONFIDENCE_CLAIM)?.[0] ?? "",
      });
    }
  }
  return issues;
}

/** Strip markdown fences a model may wrap JSON in. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  // Fall back to the outermost object, ignoring any preamble.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/**
 * Run every gate over one raw model response.
 *
 * Returns the decision only if all gates pass. There is no partial acceptance:
 * a response with a fabricated figure is rejected whole, because the rationale
 * is what a merchant reads before approving a money action.
 */
export function validateLlmResponse(
  rawResponse: string | null,
  input: ReasonerInput,
): ValidationResult {
  if (rawResponse === null || rawResponse.trim() === "") {
    return {
      ok: false,
      outcome: "EMPTY_RESPONSE",
      issues: [
        { outcome: "EMPTY_RESPONSE", field: "response", message: "Model returned no content." },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawResponse));
  } catch (error) {
    return {
      ok: false,
      outcome: "MALFORMED_JSON",
      issues: [
        {
          outcome: "MALFORMED_JSON",
          field: "response",
          message: `Response is not valid JSON: ${(error as Error).message}`,
        },
      ],
    };
  }

  const schemaResult = llmDecisionSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      outcome: "SCHEMA_INVALID",
      issues: schemaResult.error.issues.map((issue) => ({
        outcome: "SCHEMA_INVALID" as const,
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  const decision = schemaResult.data;

  // Gate 4: the model may only pick from what it was given. This is what makes
  // prompt injection structurally unable to reach an unavailable action.
  const selected = input.candidates.find(
    (candidate) => candidate.playbookId === decision.selectedPlaybookId,
  );
  if (!selected) {
    return {
      ok: false,
      outcome: "UNKNOWN_PLAYBOOK",
      issues: [
        {
          outcome: "UNKNOWN_PLAYBOOK",
          field: "selectedPlaybookId",
          message:
            `"${decision.selectedPlaybookId}" is not among the supplied candidates ` +
            `(${input.candidates.map((c) => c.playbookId).join(", ")}).`,
          observed: decision.selectedPlaybookId,
        },
      ],
    };
  }

  const allowed = buildAllowedValues(input);
  const issues: ValidationIssue[] = [
    ...checkProse(decision.rationale, "rationale", allowed),
    ...checkProse(decision.confidenceNote, "confidenceNote", allowed),
    ...decision.risksIdentified.flatMap((risk, index) =>
      checkProse(risk, `risksIdentified[${index}]`, allowed),
    ),
    ...checkCustomerMessage(decision.customerMessage, selected),
    ...checkConfidence(decision, selected),
  ];

  if (issues.length > 0) {
    // Report the most fundamental failure first: a fabricated number is worse
    // than an overstated tone.
    const priority: readonly ValidationIssue["outcome"][] = [
      "NUMERIC_HALLUCINATION",
      "UNSUPPORTED_MESSAGE_CLAIM",
      "CONFIDENCE_OVERCLAIM",
    ];
    const outcome =
      priority.find((candidate) => issues.some((issue) => issue.outcome === candidate)) ??
      issues[0]!.outcome;
    return { ok: false, outcome, issues };
  }

  return { ok: true, decision, issues: [] };
}
