import { describe, expect, it } from "vitest";

import { ALLOWED_TRANSITIONS, canTransition, checkTransition, isExpired, isTerminal } from "@/core/state-machine";
import type { InterventionState } from "@/core/state-machine";

const NOW = new Date("2026-09-06T12:00:00Z");
const PAST = new Date("2026-09-05T12:00:00Z");
const FUTURE = new Date("2026-09-07T12:00:00Z");

describe("intervention state machine", () => {
  describe("legal transitions", () => {
    it.each([
      ["DRAFT", "PROPOSED"],
      ["PROPOSED", "PENDING_APPROVAL"],
      ["PROPOSED", "GUARDRAIL_BLOCKED"],
      ["PENDING_APPROVAL", "APPROVED"],
      ["PENDING_APPROVAL", "REJECTED"],
      ["PENDING_APPROVAL", "EXPIRED"],
      ["PENDING_APPROVAL", "CANCELLED"],
      ["APPROVED", "GUARDRAIL_BLOCKED"],
    ] as const)("allows %s -> %s", (from, to) => {
      expect(canTransition(from, to).allowed).toBe(true);
    });
  });

  describe("illegal transitions", () => {
    it("refuses to skip the human gate", () => {
      // The most important edge that must not exist.
      expect(canTransition("PROPOSED", "APPROVED").allowed).toBe(false);
      expect(canTransition("PENDING_APPROVAL", "EXECUTING").allowed).toBe(false);
      expect(canTransition("APPROVED", "EXECUTED").allowed).toBe(false);
    });

    it("lets ONLY an approved intervention reach an execution state", () => {
      // Execution states exist now, but the human gate cannot be bypassed:
      // nothing before APPROVED has an edge into one.
      const executionStates: InterventionState[] = [
        "EXECUTING", "EXECUTED", "EXECUTION_FAILED", "OBSERVING",
      ];
      const preApprovalStates: InterventionState[] = [
        "DRAFT", "PROPOSED", "PENDING_APPROVAL",
      ];
      for (const from of preApprovalStates) {
        for (const state of executionStates) {
          expect(ALLOWED_TRANSITIONS[from]).not.toContain(state);
        }
      }
      // EXECUTING is reachable only from APPROVED, or from a bounded retry.
      const intoExecuting = Object.entries(ALLOWED_TRANSITIONS)
        .filter(([, targets]) => targets.includes("EXECUTING"))
        .map(([from]) => from)
        .sort();
      expect(intoExecuting).toEqual(["APPROVED", "EXECUTION_FAILED"]);
    });

    it("reaches an outcome state ONLY from OBSERVING", () => {
      // CONVERTED and NOT_CONVERTED require provider evidence, which only
      // arrives while an intervention is observing. Nothing else may set them.
      const intoOutcome = Object.entries(ALLOWED_TRANSITIONS)
        .filter(([, targets]) => targets.includes("CONVERTED") || targets.includes("NOT_CONVERTED"))
        .map(([from]) => from);
      expect(intoOutcome).toEqual(["OBSERVING"]);
    });

    it("reaches LEARNED only from a recorded outcome", () => {
      // LEARNED is what makes the PlaybookStat update idempotent: it is
      // terminal, so the counters can only ever be incremented once.
      const intoLearned = Object.entries(ALLOWED_TRANSITIONS)
        .filter(([, targets]) => targets.includes("LEARNED"))
        .map(([from]) => from)
        .sort();
      expect(intoLearned).toEqual(["CONVERTED", "NOT_CONVERTED"]);
      expect(isTerminal("LEARNED")).toBe(true);
    });

    it("never reaches an outcome state directly from execution", () => {
      // Creating a payment link is not evidence that anyone paid.
      for (const from of ["APPROVED", "EXECUTING", "EXECUTED"] as const) {
        for (const state of ["CONVERTED", "NOT_CONVERTED", "LEARNED"] as const) {
          expect(ALLOWED_TRANSITIONS[from]).not.toContain(state);
        }
      }
    });

    it("refuses to leave a terminal state", () => {
      for (const state of ["REJECTED", "EXPIRED", "CANCELLED", "GUARDRAIL_BLOCKED"] as const) {
        expect(isTerminal(state)).toBe(true);
        const check = canTransition(state, "APPROVED");
        expect(check.allowed).toBe(false);
        if (!check.allowed) expect(check.code).toBe("TERMINAL_STATE");
      }
    });

    it("refuses a no-op transition", () => {
      expect(canTransition("PENDING_APPROVAL", "PENDING_APPROVAL").allowed).toBe(false);
    });

    it("refuses to un-reject", () => {
      expect(canTransition("REJECTED", "PENDING_APPROVAL").allowed).toBe(false);
    });
  });

  describe("optimistic versioning", () => {
    const base = {
      from: "PENDING_APPROVAL" as const, to: "APPROVED" as const,
      expiresAt: FUTURE, evaluatedAt: NOW,
    };

    it("accepts a matching version", () => {
      expect(checkTransition({ ...base, expectedVersion: 3, currentVersion: 3 }).allowed).toBe(true);
    });

    it("rejects a stale version with an actionable message", () => {
      const check = checkTransition({ ...base, expectedVersion: 2, currentVersion: 3 });
      expect(check.allowed).toBe(false);
      if (check.allowed) return;
      expect(check.code).toBe("STALE_VERSION");
      expect(check.reason).toContain("Reload");
    });

    it("checks version before expiry, so a stale caller is told the useful thing", () => {
      const check = checkTransition({
        ...base, expiresAt: PAST, expectedVersion: 1, currentVersion: 5,
      });
      expect(check.allowed).toBe(false);
      if (check.allowed) return;
      expect(check.code).toBe("STALE_VERSION");
    });
  });

  describe("expiry", () => {
    it("refuses approval after expiry", () => {
      const check = checkTransition({
        from: "PENDING_APPROVAL", to: "APPROVED", expiresAt: PAST,
        evaluatedAt: NOW, expectedVersion: 1, currentVersion: 1,
      });
      expect(check.allowed).toBe(false);
      if (check.allowed) return;
      expect(check.code).toBe("EXPIRED");
    });

    it("still allows an expired proposal to be moved to a terminal state", () => {
      // Otherwise a lapsed proposal would be stuck forever.
      expect(checkTransition({
        from: "PENDING_APPROVAL", to: "EXPIRED", expiresAt: PAST,
        evaluatedAt: NOW, expectedVersion: 1, currentVersion: 1,
      }).allowed).toBe(true);
    });

    it("treats a null expiry as never expiring", () => {
      expect(isExpired("PENDING_APPROVAL", null, NOW)).toBe(false);
      expect(checkTransition({
        from: "PENDING_APPROVAL", to: "APPROVED", expiresAt: null,
        evaluatedAt: NOW, expectedVersion: 1, currentVersion: 1,
      }).allowed).toBe(true);
    });

    it("does not expire a terminal intervention", () => {
      expect(isExpired("REJECTED", PAST, NOW)).toBe(false);
      expect(isExpired("PENDING_APPROVAL", PAST, NOW)).toBe(true);
    });

    it("expires exactly at the boundary instant", () => {
      expect(isExpired("PENDING_APPROVAL", NOW, NOW)).toBe(true);
      expect(isExpired("PENDING_APPROVAL", new Date(NOW.getTime() + 1), NOW)).toBe(false);
    });
  });
});
