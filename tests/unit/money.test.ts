import { describe, expect, it } from "vitest";

import {
  MAX_PAISE,
  MoneyError,
  applyBps,
  formatPaise,
  isValidPaise,
  paise,
  rupeesToPaise,
  sumPaise,
} from "@/lib/money";

describe("money representation", () => {
  describe("paise()", () => {
    it("accepts whole paise", () => {
      expect(paise(0)).toBe(0);
      expect(paise(51_427_400)).toBe(51_427_400);
    });

    it("rejects fractional values rather than rounding them away", () => {
      // Silently rounding is how money goes missing. Fail loudly instead.
      expect(() => paise(100.5)).toThrow(MoneyError);
      expect(() => paise(0.1)).toThrow(/integer number of paise/);
    });

    it("rejects negative, non-finite, and over-ceiling values", () => {
      expect(() => paise(-1)).toThrow(MoneyError);
      expect(() => paise(Number.NaN)).toThrow(MoneyError);
      expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
      expect(() => paise(MAX_PAISE + 1)).toThrow(/INTEGER column ceiling/);
    });

    it("accepts exactly the INTEGER column ceiling", () => {
      expect(paise(MAX_PAISE)).toBe(MAX_PAISE);
    });
  });

  describe("rupeesToPaise()", () => {
    it("converts at the ingest boundary", () => {
      expect(rupeesToPaise(499)).toBe(49_900);
      expect(rupeesToPaise(89_999)).toBe(8_999_900);
      expect(rupeesToPaise(0.01)).toBe(1);
    });

    it("survives values that binary floating point cannot represent exactly", () => {
      // 0.1 + 0.2 !== 0.3 in IEEE 754; this is why money is never stored as rupees.
      expect(rupeesToPaise(1499.99)).toBe(149_999);
      expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    });

    it("rejects sub-paise precision", () => {
      expect(() => rupeesToPaise(1.005)).toThrow(/sub-paise precision/);
    });
  });

  describe("sumPaise()", () => {
    it("sums integer paise exactly", () => {
      expect(sumPaise([49_900, 149_900, 8_999_900])).toBe(9_199_700);
      expect(sumPaise([])).toBe(0);
    });

    it("adds without floating-point drift", () => {
      // The same addition in rupees would drift; in paise it is exact.
      const hundredTenPaiseAmounts = Array.from({ length: 100 }, () => 10);
      expect(sumPaise(hundredTenPaiseAmounts)).toBe(1_000);
    });

    it("may exceed the per-column ceiling, because totals are displayed not stored", () => {
      expect(sumPaise([MAX_PAISE, MAX_PAISE])).toBe(MAX_PAISE * 2);
    });

    it("rejects non-integer members", () => {
      expect(() => sumPaise([100, 0.5])).toThrow(MoneyError);
    });
  });

  describe("applyBps()", () => {
    it("applies integer basis-point rates", () => {
      expect(applyBps(100_000, 1_000)).toBe(10_000); // 10% of Rs 1,000
      expect(applyBps(100_000, 200)).toBe(2_000); // 2% gateway fee
      expect(applyBps(100_000, 0)).toBe(0);
      expect(applyBps(100_000, 10_000)).toBe(100_000);
    });

    it("rounds half-up to whole paise", () => {
      expect(applyBps(333, 1_000)).toBe(33);
      expect(applyBps(335, 1_000)).toBe(34);
    });

    it("rejects rates outside 0..10000 and non-integer rates", () => {
      expect(() => applyBps(1_000, -1)).toThrow(MoneyError);
      expect(() => applyBps(1_000, 10_001)).toThrow(MoneyError);
      expect(() => applyBps(1_000, 12.5)).toThrow(MoneyError);
    });
  });

  describe("formatPaise()", () => {
    it("renders with Indian digit grouping", () => {
      expect(formatPaise(51_427_400)).toBe("₹5,14,274.00");
      expect(formatPaise(1_120_859_100)).toBe("₹1,12,08,591.00");
      expect(formatPaise(49_900)).toBe("₹499.00");
      expect(formatPaise(1)).toBe("₹0.01");
    });

    it("handles negatives and the symbol-free variant", () => {
      expect(formatPaise(-49_900)).toBe("-₹499.00");
      expect(formatPaise(49_900, { withSymbol: false })).toBe("499.00");
    });

    it("refuses to format a non-integer", () => {
      expect(() => formatPaise(499.5)).toThrow(MoneyError);
    });
  });

  describe("isValidPaise()", () => {
    it("discriminates valid paise values", () => {
      expect(isValidPaise(0)).toBe(true);
      expect(isValidPaise(49_900)).toBe(true);
      expect(isValidPaise(49_900.5)).toBe(false);
      expect(isValidPaise(-1)).toBe(false);
      expect(isValidPaise("49900")).toBe(false);
      expect(isValidPaise(MAX_PAISE + 1)).toBe(false);
    });
  });
});
