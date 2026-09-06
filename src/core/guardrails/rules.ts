/**
 * The ten MVP guardrail rules.
 *
 * Each is a pure function from context to verdict. They are deliberately dull:
 * a guardrail that is clever is a guardrail nobody can predict, and the whole
 * point is that a merchant can look at the table and know why.
 *
 * Every rule reports `observed` and `limit` even when it passes, so the UI can
 * show what was checked rather than only what failed.
 */
import type { GuardrailContext, RuleResult, RuleId } from "./types";

const CONFIDENCE_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const percent = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** Hour of day in the merchant's timezone. Pure: derived from the given instant. */
export function hourInTimezone(instant: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", hour12: false, timeZone: timezone,
    }).format(instant);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : instant.getUTCHours();
  } catch {
    // An unknown timezone must not crash an evaluation; fall back to UTC.
    return instant.getUTCHours();
  }
}

/**
 * Is `hour` inside a window that may wrap past midnight?
 * Quiet hours of 21:00-09:00 wrap, so a plain `>=` comparison would be wrong.
 */
export function isWithinWrappingWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

type RuleEvaluator = (context: GuardrailContext) => RuleResult;

/** 1. Cap the discount rate on any single action. */
const maxDiscountBps: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.MAX_DISCOUNT_BPS;
  const passed = action.discountBps <= rule.limit;
  return {
    ruleId: "MAX_DISCOUNT_BPS",
    label: "Maximum discount rate",
    severity: rule.severity,
    passed,
    observed: percent(action.discountBps),
    limit: percent(rule.limit),
    message: passed
      ? `Discount of ${percent(action.discountBps)} is within the ${percent(rule.limit)} ceiling.`
      : `Discount of ${percent(action.discountBps)} exceeds the ${percent(rule.limit)} ceiling.`,
  };
};

/** 2. Cap the total money given away by one action. */
const maxSingleActionExposure: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.MAX_SINGLE_ACTION_EXPOSURE_PAISE;
  const passed = action.discountCostPaise <= rule.limit;
  return {
    ruleId: "MAX_SINGLE_ACTION_EXPOSURE_PAISE",
    label: "Maximum exposure per action",
    severity: rule.severity,
    passed,
    observed: rupees(action.discountCostPaise),
    limit: rupees(rule.limit),
    message: passed
      ? `Exposure of ${rupees(action.discountCostPaise)} is within the ${rupees(rule.limit)} per-action cap.`
      : `Exposure of ${rupees(action.discountCostPaise)} exceeds the ${rupees(rule.limit)} per-action cap.`,
  };
};

/**
 * 3. Rolling discount budget.
 *
 * Measures what is ALREADY committed plus what this action would add — a budget
 * that only counted spent money would let an unlimited number of pending
 * actions through.
 */
const dailyDiscountBudget: RuleEvaluator = ({ action, policy, state }) => {
  const rule = policy.DAILY_DISCOUNT_BUDGET_PAISE;
  const projected = state.dailyDiscountCommittedPaise + action.discountCostPaise;
  const passed = projected <= rule.limit;
  return {
    ruleId: "DAILY_DISCOUNT_BUDGET_PAISE",
    label: "Daily discount budget",
    severity: rule.severity,
    passed,
    observed: rupees(projected),
    limit: rupees(rule.limit),
    message: passed
      ? `Committed ${rupees(state.dailyDiscountCommittedPaise)} plus this action's ` +
        `${rupees(action.discountCostPaise)} stays within the ${rupees(rule.limit)} daily budget.`
      : `Committed ${rupees(state.dailyDiscountCommittedPaise)} plus this action's ` +
        `${rupees(action.discountCostPaise)} would reach ${rupees(projected)}, over the ` +
        `${rupees(rule.limit)} daily budget.`,
  };
};

/** 4. The agent must not act at a loss. */
const minExpectedNet: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.MIN_EXPECTED_NET_PAISE;
  const passed = action.expectedNetPaise >= rule.limit;
  return {
    ruleId: "MIN_EXPECTED_NET_PAISE",
    label: "Minimum expected net revenue",
    severity: rule.severity,
    passed,
    observed: rupees(action.expectedNetPaise),
    limit: rupees(rule.limit),
    message: passed
      ? `Expected net of ${rupees(action.expectedNetPaise)} clears the ${rupees(rule.limit)} floor.`
      : `Expected net of ${rupees(action.expectedNetPaise)} is below the ${rupees(rule.limit)} floor.`,
  };
};

/** 5. Contact fatigue: nobody gets messaged more than the policy allows. */
const maxContactsPerCustomer: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.MAX_CONTACTS_PER_CUSTOMER;
  // One more contact is what this action would add to each target.
  const worst = action.targets.reduce(
    (max, target) => Math.max(max, target.recentContactCount + 1),
    0,
  );
  const offenders = action.targets.filter((t) => t.recentContactCount + 1 > rule.limit);
  const passed = offenders.length === 0;
  return {
    ruleId: "MAX_CONTACTS_PER_CUSTOMER",
    label: "Contact frequency per customer",
    severity: rule.severity,
    passed,
    observed: `${worst} in ${rule.window_days}d`,
    limit: `${rule.limit} in ${rule.window_days}d`,
    message: passed
      ? `No customer would exceed ${rule.limit} contact(s) in ${rule.window_days} days.`
      : `${offenders.length} customer(s) would exceed ${rule.limit} contact(s) in ` +
        `${rule.window_days} days.`,
  };
};

/** 6. Consent. An active suppression is absolute. */
const doNotContact: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.DO_NOT_CONTACT;
  const suppressed = action.targets.filter((target) => target.isSuppressed);
  const passed = suppressed.length === 0;
  return {
    ruleId: "DO_NOT_CONTACT",
    label: "Do-not-contact list",
    severity: rule.severity,
    passed,
    observed: `${suppressed.length} suppressed`,
    limit: "0 suppressed",
    message: passed
      ? "No target is under an active do-not-contact suppression."
      : `${suppressed.length} target(s) are under an active do-not-contact suppression.`,
  };
};

/**
 * 7. Quiet hours.
 *
 * REQUIRE_APPROVAL rather than BLOCK: sending at 22:00 is a scheduling question
 * a human can answer, not a prohibition.
 */
const quietHours: RuleEvaluator = ({ policy, state, evaluatedAt }) => {
  const rule = policy.QUIET_HOURS;
  const hour = hourInTimezone(evaluatedAt, state.timezone);
  const inQuietHours = isWithinWrappingWindow(hour, rule.start_hour, rule.end_hour);
  const window = `${String(rule.start_hour).padStart(2, "0")}:00-${String(rule.end_hour).padStart(2, "0")}:00`;
  return {
    ruleId: "QUIET_HOURS",
    label: "Quiet hours",
    severity: rule.severity,
    passed: !inQuietHours,
    observed: `${String(hour).padStart(2, "0")}:00 ${state.timezone}`,
    limit: `outside ${window}`,
    message: inQuietHours
      ? `Local time ${String(hour).padStart(2, "0")}:00 falls inside quiet hours (${window}).`
      : `Local time ${String(hour).padStart(2, "0")}:00 is outside quiet hours (${window}).`,
  };
};

/** 8. Bounded autonomy: a cap on simultaneous live interventions. */
const maxConcurrentLive: RuleEvaluator = ({ policy, state }) => {
  const rule = policy.MAX_CONCURRENT_LIVE;
  const projected = state.concurrentLiveCount + 1;
  const passed = projected <= rule.limit;
  return {
    ruleId: "MAX_CONCURRENT_LIVE",
    label: "Concurrent live interventions",
    severity: rule.severity,
    passed,
    observed: projected,
    limit: rule.limit,
    message: passed
      ? `${state.concurrentLiveCount} live now; this would make ${projected}, within the cap of ${rule.limit}.`
      : `${state.concurrentLiveCount} live now; this would make ${projected}, over the cap of ${rule.limit}.`,
  };
};

/**
 * 9. Test mode. The non-negotiable kill switch.
 *
 * There is no live-mode code path in this build, and this rule asserts it at
 * evaluation time as well.
 */
const testModeOnly: RuleEvaluator = ({ policy, state }) => {
  const rule = policy.TEST_MODE_ONLY;
  const passed = state.mode === "TEST";
  return {
    ruleId: "TEST_MODE_ONLY",
    label: "Test mode only",
    severity: rule.severity,
    passed,
    observed: state.mode,
    limit: "TEST",
    message: passed
      ? "Merchant is in TEST mode; no live money can move."
      : `Merchant is in ${state.mode} mode. This build permits TEST mode only.`,
  };
};

/** 10. Surface uncertainty rather than hide it. */
const lowConfidence: RuleEvaluator = ({ action, policy }) => {
  const rule = policy.LOW_CONFIDENCE;
  const observed = CONFIDENCE_RANK[action.confidence] ?? 0;
  const required = CONFIDENCE_RANK[rule.min_confidence] ?? 0;
  const passed = observed >= required;
  return {
    ruleId: "LOW_CONFIDENCE",
    label: "Estimate confidence",
    severity: rule.severity,
    passed,
    observed: action.confidence,
    limit: `at least ${rule.min_confidence}`,
    message: passed
      ? `Estimate confidence is ${action.confidence}, at or above the ${rule.min_confidence} threshold.`
      : `Estimate confidence is ${action.confidence}, below the ${rule.min_confidence} threshold.`,
  };
};

/** Evaluation order is fixed, so the table reads the same way every time. */
export const RULE_EVALUATORS: ReadonlyArray<readonly [RuleId, RuleEvaluator]> = [
  ["TEST_MODE_ONLY", testModeOnly],
  ["DO_NOT_CONTACT", doNotContact],
  ["MAX_DISCOUNT_BPS", maxDiscountBps],
  ["MAX_SINGLE_ACTION_EXPOSURE_PAISE", maxSingleActionExposure],
  ["DAILY_DISCOUNT_BUDGET_PAISE", dailyDiscountBudget],
  ["MIN_EXPECTED_NET_PAISE", minExpectedNet],
  ["MAX_CONTACTS_PER_CUSTOMER", maxContactsPerCustomer],
  ["MAX_CONCURRENT_LIVE", maxConcurrentLive],
  ["QUIET_HOURS", quietHours],
  ["LOW_CONFIDENCE", lowConfidence],
];
