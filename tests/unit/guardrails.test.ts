import { describe, expect, it } from "vitest";

import {
  evaluateGuardrails, hourInTimezone, isWithinWrappingWindow,
} from "@/core/guardrails";
import type {
  ActionTarget, GuardrailContext, GuardrailPolicyRules, ProposedAction,
} from "@/core/guardrails";

/** Boundary-first tests: every rule is checked at the limit, one under, one over. */

const POLICY: GuardrailPolicyRules = {
  MAX_DISCOUNT_BPS: { severity: "BLOCK", limit: 1_500 },
  MAX_SINGLE_ACTION_EXPOSURE_PAISE: { severity: "BLOCK", limit: 5_000_000 },
  DAILY_DISCOUNT_BUDGET_PAISE: { severity: "BLOCK", limit: 2_500_000 },
  MIN_EXPECTED_NET_PAISE: { severity: "BLOCK", limit: 100_000 },
  MAX_CONTACTS_PER_CUSTOMER: { severity: "BLOCK", limit: 2, window_days: 7 },
  DO_NOT_CONTACT: { severity: "BLOCK" },
  QUIET_HOURS: { severity: "REQUIRE_APPROVAL", start_hour: 21, end_hour: 9 },
  MAX_CONCURRENT_LIVE: { severity: "BLOCK", limit: 3 },
  TEST_MODE_ONLY: { severity: "BLOCK" },
  LOW_CONFIDENCE: { severity: "REQUIRE_APPROVAL", min_confidence: "MEDIUM" },
};

/** 14:00 IST — outside quiet hours, so unrelated rules can be tested in isolation. */
const MIDDAY = new Date("2026-09-06T08:30:00Z");

function target(overrides: Partial<ActionTarget> = {}): ActionTarget {
  return {
    customerId: "c1", customerRef: "cust_0001", transactionId: "t1",
    amountPaise: 500_000, recentContactCount: 0, isSuppressed: false, ...overrides,
  };
}

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    interventionId: "i1", playbookId: "pb1", playbookKey: "PAYMENT_LINK_PLAIN",
    discountBps: 0, expectedGrossPaise: 1_000_000, expectedNetPaise: 900_000,
    discountCostPaise: 0, costPaise: 100_000, confidence: "MEDIUM",
    targets: [target()], ...overrides,
  };
}

function context(overrides: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    phase: "PRE_APPROVAL", evaluatedAt: MIDDAY, action: action(), policy: POLICY,
    policyVersion: 1,
    state: {
      mode: "TEST", timezone: "Asia/Kolkata",
      dailyDiscountCommittedPaise: 0, concurrentLiveCount: 0,
    },
    ...overrides,
  };
}

const rule = (result: ReturnType<typeof evaluateGuardrails>, ruleId: string) =>
  result.results.find((entry) => entry.ruleId === ruleId)!;

describe("guardrail engine", () => {
  it("passes cleanly when nothing is wrong", () => {
    const result = evaluateGuardrails(context());
    expect(result.decision).toBe("PASS");
    expect(result.blocked).toBe(false);
    expect(result.failures).toHaveLength(0);
    // All ten rules run and report, pass or fail.
    expect(result.results).toHaveLength(10);
  });

  it("evaluates every rule even after one blocks", () => {
    // A merchant looking at a block needs the whole picture, not the first objection.
    const result = evaluateGuardrails(
      context({ action: action({ discountBps: 9_999, expectedNetPaise: 0, confidence: "LOW" }) }),
    );
    expect(result.results).toHaveLength(10);
    expect(result.failures.length).toBeGreaterThan(1);
  });

  describe("MAX_DISCOUNT_BPS", () => {
    it("passes at the limit and fails one basis point over", () => {
      expect(rule(evaluateGuardrails(context({ action: action({ discountBps: 1_500 }) })), "MAX_DISCOUNT_BPS").passed).toBe(true);
      expect(rule(evaluateGuardrails(context({ action: action({ discountBps: 1_501 }) })), "MAX_DISCOUNT_BPS").passed).toBe(false);
    });
  });

  describe("MAX_SINGLE_ACTION_EXPOSURE_PAISE", () => {
    it("passes at the limit and fails one paisa over", () => {
      expect(rule(evaluateGuardrails(context({ action: action({ discountCostPaise: 5_000_000 }) })), "MAX_SINGLE_ACTION_EXPOSURE_PAISE").passed).toBe(true);
      expect(rule(evaluateGuardrails(context({ action: action({ discountCostPaise: 5_000_001 }) })), "MAX_SINGLE_ACTION_EXPOSURE_PAISE").passed).toBe(false);
    });
  });

  describe("DAILY_DISCOUNT_BUDGET_PAISE", () => {
    it("counts committed spend plus this action", () => {
      const result = evaluateGuardrails(context({
        action: action({ discountCostPaise: 1_000_000 }),
        state: { mode: "TEST", timezone: "Asia/Kolkata", dailyDiscountCommittedPaise: 1_600_000, concurrentLiveCount: 0 },
      }));
      // 16,00,000 + 10,00,000 = 26,00,000 > 25,00,000
      expect(rule(result, "DAILY_DISCOUNT_BUDGET_PAISE").passed).toBe(false);
      expect(result.decision).toBe("BLOCK");
    });

    it("passes exactly at the budget", () => {
      const result = evaluateGuardrails(context({
        action: action({ discountCostPaise: 900_000 }),
        state: { mode: "TEST", timezone: "Asia/Kolkata", dailyDiscountCommittedPaise: 1_600_000, concurrentLiveCount: 0 },
      }));
      expect(rule(result, "DAILY_DISCOUNT_BUDGET_PAISE").passed).toBe(true);
    });
  });

  describe("MIN_EXPECTED_NET_PAISE", () => {
    it("passes at the floor and fails below it", () => {
      expect(rule(evaluateGuardrails(context({ action: action({ expectedNetPaise: 100_000 }) })), "MIN_EXPECTED_NET_PAISE").passed).toBe(true);
      expect(rule(evaluateGuardrails(context({ action: action({ expectedNetPaise: 99_999 }) })), "MIN_EXPECTED_NET_PAISE").passed).toBe(false);
    });

    it("blocks a value-destroying action", () => {
      const result = evaluateGuardrails(context({ action: action({ expectedNetPaise: -50_000 }) }));
      expect(result.blocked).toBe(true);
    });
  });

  describe("MAX_CONTACTS_PER_CUSTOMER", () => {
    it("counts this action as one more contact", () => {
      // Already contacted once; this makes two, which is the limit.
      expect(rule(evaluateGuardrails(context({ action: action({ targets: [target({ recentContactCount: 1 })] }) })), "MAX_CONTACTS_PER_CUSTOMER").passed).toBe(true);
      expect(rule(evaluateGuardrails(context({ action: action({ targets: [target({ recentContactCount: 2 })] }) })), "MAX_CONTACTS_PER_CUSTOMER").passed).toBe(false);
    });

    it("fails if any single target is over, not the average", () => {
      const result = evaluateGuardrails(context({
        action: action({
          targets: [
            target({ customerId: "a", recentContactCount: 0 }),
            target({ customerId: "b", recentContactCount: 0 }),
            target({ customerId: "c", recentContactCount: 5 }),
          ],
        }),
      }));
      expect(rule(result, "MAX_CONTACTS_PER_CUSTOMER").passed).toBe(false);
    });
  });

  describe("DO_NOT_CONTACT", () => {
    it("blocks when any target is actively suppressed", () => {
      const result = evaluateGuardrails(context({
        action: action({ targets: [target(), target({ customerId: "b", isSuppressed: true })] }),
      }));
      expect(rule(result, "DO_NOT_CONTACT").passed).toBe(false);
      expect(result.blocked).toBe(true);
    });
  });

  describe("QUIET_HOURS", () => {
    it("handles a window that wraps past midnight", () => {
      expect(isWithinWrappingWindow(22, 21, 9)).toBe(true);
      expect(isWithinWrappingWindow(3, 21, 9)).toBe(true);
      expect(isWithinWrappingWindow(9, 21, 9)).toBe(false);
      expect(isWithinWrappingWindow(14, 21, 9)).toBe(false);
    });

    it("requires approval rather than blocking", () => {
      // 22:30 IST
      const result = evaluateGuardrails(context({ evaluatedAt: new Date("2026-09-06T17:00:00Z") }));
      expect(rule(result, "QUIET_HOURS").passed).toBe(false);
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.blocked).toBe(false);
    });

    it("reads the hour in the merchant's timezone", () => {
      expect(hourInTimezone(new Date("2026-09-06T08:30:00Z"), "Asia/Kolkata")).toBe(14);
      expect(hourInTimezone(new Date("2026-09-06T08:30:00Z"), "UTC")).toBe(8);
    });

    it("falls back to UTC for an unknown timezone rather than throwing", () => {
      expect(hourInTimezone(new Date("2026-09-06T08:30:00Z"), "Not/AZone")).toBe(8);
    });
  });

  describe("MAX_CONCURRENT_LIVE", () => {
    it("counts this action as one more live intervention", () => {
      const at = (live: number) => evaluateGuardrails(context({
        state: { mode: "TEST", timezone: "Asia/Kolkata", dailyDiscountCommittedPaise: 0, concurrentLiveCount: live },
      }));
      expect(rule(at(2), "MAX_CONCURRENT_LIVE").passed).toBe(true);
      expect(rule(at(3), "MAX_CONCURRENT_LIVE").passed).toBe(false);
    });
  });

  describe("TEST_MODE_ONLY", () => {
    it("blocks anything that is not TEST mode", () => {
      const result = evaluateGuardrails(context({
        state: { mode: "LIVE", timezone: "Asia/Kolkata", dailyDiscountCommittedPaise: 0, concurrentLiveCount: 0 },
      }));
      expect(rule(result, "TEST_MODE_ONLY").passed).toBe(false);
      expect(result.blocked).toBe(true);
    });
  });

  describe("LOW_CONFIDENCE", () => {
    it("requires approval below the threshold and passes at or above it", () => {
      expect(rule(evaluateGuardrails(context({ action: action({ confidence: "LOW" }) })), "LOW_CONFIDENCE").passed).toBe(false);
      expect(rule(evaluateGuardrails(context({ action: action({ confidence: "MEDIUM" }) })), "LOW_CONFIDENCE").passed).toBe(true);
      expect(rule(evaluateGuardrails(context({ action: action({ confidence: "HIGH" }) })), "LOW_CONFIDENCE").passed).toBe(true);
    });
  });

  describe("severity aggregation", () => {
    it("takes the most severe failure, never an average", () => {
      const result = evaluateGuardrails(context({
        action: action({ confidence: "LOW", expectedNetPaise: 0 }),
      }));
      // LOW_CONFIDENCE is REQUIRE_APPROVAL, MIN_EXPECTED_NET is BLOCK.
      expect(result.decision).toBe("BLOCK");
      expect(result.failures[0]!.severity).toBe("BLOCK");
    });

    it("reports REQUIRE_APPROVAL when only soft rules fail", () => {
      const result = evaluateGuardrails(context({ action: action({ confidence: "LOW" }) }));
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.blocked).toBe(false);
    });

    it("respects a policy that changes a rule's severity", () => {
      const lenient = evaluateGuardrails(context({
        policy: { ...POLICY, MIN_EXPECTED_NET_PAISE: { severity: "WARN", limit: 100_000 } },
        action: action({ expectedNetPaise: 0 }),
      }));
      expect(lenient.decision).toBe("WARN");
      expect(lenient.blocked).toBe(false);
    });
  });

  describe("determinism and phases", () => {
    it("produces identical output for identical input", () => {
      expect(JSON.stringify(evaluateGuardrails(context())))
        .toBe(JSON.stringify(evaluateGuardrails(context())));
    });

    it("applies the same rules in both phases", () => {
      const pre = evaluateGuardrails(context({ phase: "PRE_APPROVAL" }));
      const exec = evaluateGuardrails(context({ phase: "PRE_EXECUTION" }));
      expect(exec.results.map((r) => r.ruleId)).toEqual(pre.results.map((r) => r.ruleId));
      expect(exec.decision).toBe(pre.decision);
    });

    it("records the policy version it ran under", () => {
      expect(evaluateGuardrails(context({ policyVersion: 7 })).policyVersion).toBe(7);
    });

    it("reports observed and limit on passing rules too", () => {
      for (const result of evaluateGuardrails(context()).results) {
        expect(String(result.observed).length).toBeGreaterThan(0);
        expect(String(result.limit).length).toBeGreaterThan(0);
        expect(result.message.length).toBeGreaterThan(10);
      }
    });
  });
});
