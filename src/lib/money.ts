/**
 * Money handling for RevenuePilot.
 *
 * THE RULE: money is an integer number of paise, everywhere, always. No float
 * ever touches a monetary value — not in the database, not in the estimator,
 * not in transport. Floats are introduced only at the very last step, to render
 * a string for a human, and never read back.
 *
 * Rationale: RevenuePilot's entire claim is that its numbers are traceable and
 * reproducible. Binary floating point cannot represent 0.1 exactly, so repeated
 * rupee-scale arithmetic drifts. A demo that shows a different total on the
 * second run has lost the argument before anyone asks a question.
 */

/**
 * Paise, branded so a plain number cannot be passed where money is expected.
 * Use {@link paise} to construct and {@link toNumber} to unwrap.
 */
export type Paise = number & { readonly __brand: "Paise" };

/** Postgres INTEGER ceiling — the largest value a paise column can hold. */
export const MAX_PAISE = 2_147_483_647;

/** ~Rs 2.14 crore. Documented in docs/DATA_MODEL.md as the per-column ceiling. */
export const MAX_PAISE_AS_RUPEES = MAX_PAISE / 100;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** True when `value` is a safe, non-negative integer within the column ceiling. */
export function isValidPaise(value: unknown): value is Paise {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PAISE
  );
}

/** Construct a Paise value, rejecting anything that is not a clean integer. */
export function paise(value: number): Paise {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError(`Not a finite number: ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Money must be an integer number of paise, got ${value}. ` +
        "Rupee-scale values must be converted with rupeesToPaise() at the boundary.",
    );
  }
  if (value < 0) {
    throw new MoneyError(`Money must be non-negative, got ${value}`);
  }
  if (value > MAX_PAISE) {
    throw new MoneyError(
      `${value} paise exceeds the INTEGER column ceiling of ${MAX_PAISE}`,
    );
  }
  return value as Paise;
}

/** Unwrap a branded Paise back to a plain number for storage or transport. */
export function toNumber(value: Paise): number {
  return value;
}

/**
 * Convert a rupee-scale figure to paise. Only for ingest boundaries, where an
 * external system hands us rupees. Rejects sub-paise precision rather than
 * silently rounding away someone's money.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`Not a finite number: ${String(rupees)}`);
  }
  const scaled = Math.round(rupees * 100);
  if (Math.abs(rupees * 100 - scaled) > 1e-6) {
    throw new MoneyError(
      `${rupees} has sub-paise precision and cannot be represented exactly`,
    );
  }
  return paise(scaled);
}

/**
 * Sum paise values. Returns a plain number rather than Paise so that an
 * aggregate exceeding the column ceiling is still computable — totals are
 * displayed, not stored.
 */
export function sumPaise(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isInteger(value)) {
      throw new MoneyError(`Cannot sum a non-integer paise value: ${value}`);
    }
    total += value;
  }
  if (!Number.isSafeInteger(total)) {
    throw new MoneyError(`Sum ${total} exceeds the safe integer range`);
  }
  return total;
}

/**
 * Apply a basis-point rate to an amount, rounding half-up to whole paise.
 *
 * Basis points keep rates in integer space too: 10% is 1000 bps, never 0.1.
 * Used for discounts (MAX_DISCOUNT_BPS), gateway fees, and recovery
 * probabilities in the estimator.
 */
export function applyBps(amountPaise: number, bps: number): number {
  if (!Number.isInteger(amountPaise)) {
    throw new MoneyError(`Amount must be integer paise, got ${amountPaise}`);
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`Basis points must be an integer in 0..10000, got ${bps}`);
  }
  return Math.round((amountPaise * bps) / 10_000);
}

/** Render paise for display only. The result is a string and never read back. */
export function formatPaise(
  value: number,
  options: { withSymbol?: boolean } = {},
): string {
  const { withSymbol = true } = options;
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Cannot format a non-integer paise value: ${value}`);
  }

  const negative = value < 0;
  const absolute = Math.abs(value);
  const rupees = Math.trunc(absolute / 100);
  const remainder = absolute % 100;

  // Indian digit grouping: 12,34,567.89
  const formatted = new Intl.NumberFormat("en-IN").format(rupees);
  const body = `${formatted}.${String(remainder).padStart(2, "0")}`;

  return `${negative ? "-" : ""}${withSymbol ? "₹" : ""}${body}`;
}
