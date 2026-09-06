/**
 * The guardrail engine.
 *
 * Pure: no I/O, no clock read, no randomness. The same context always produces
 * the same decision, which is what allows a PRE_EXECUTION run to be compared
 * meaningfully against the PRE_APPROVAL run that preceded it.
 *
 * Runs identically in both phases ON PURPOSE. The rules do not change between
 * proposal and action; only the state they are measured against does. That is
 * the entire point of evaluating twice.
 */
import { RULE_EVALUATORS } from "./rules";
import {
  SEVERITY_RANK,
  type GuardrailContext,
  type GuardrailDecision,
  type GuardrailEvaluationResult,
  type RuleResult,
} from "./types";

/**
 * Evaluate every rule and aggregate.
 *
 * ALL rules run even after one blocks. A merchant looking at a blocked action
 * needs the whole picture, not the first objection — and a partial table would
 * hide a second problem that appears only once the first is fixed.
 */
export function evaluateGuardrails(context: GuardrailContext): GuardrailEvaluationResult {
  const results: RuleResult[] = RULE_EVALUATORS.map(([, evaluate]) => evaluate(context));

  const failures = results
    .filter((result) => !result.passed)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  // The aggregate is the most severe failure. Anything else would let a BLOCK
  // be averaged away by a majority of passes.
  const decision: GuardrailDecision = failures.reduce<GuardrailDecision>(
    (worst, failure) =>
      SEVERITY_RANK[failure.severity] > SEVERITY_RANK[worst] ? failure.severity : worst,
    "PASS",
  );

  return {
    phase: context.phase,
    decision,
    policyVersion: context.policyVersion,
    evaluatedAt: context.evaluatedAt,
    results,
    failures,
    blocked: decision === "BLOCK",
  };
}

/** Compare two evaluations to explain what changed between the phases. */
export function diffEvaluations(
  before: GuardrailEvaluationResult,
  after: GuardrailEvaluationResult,
): readonly { ruleId: string; from: boolean; to: boolean; message: string }[] {
  const beforeByRule = new Map(before.results.map((result) => [result.ruleId, result]));
  const changes: { ruleId: string; from: boolean; to: boolean; message: string }[] = [];

  for (const result of after.results) {
    const previous = beforeByRule.get(result.ruleId);
    if (previous && previous.passed !== result.passed) {
      changes.push({
        ruleId: result.ruleId,
        from: previous.passed,
        to: result.passed,
        message: result.message,
      });
    }
  }
  return changes;
}
