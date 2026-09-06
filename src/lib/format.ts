/**
 * Display formatting.
 *
 * The ONLY place paise becomes a rupee string. Values are integers everywhere
 * else; this is the render boundary and the result is never read back.
 */
export function formatRupees(paise: number, options: { withSymbol?: boolean } = {}): string {
  const { withSymbol = true } = options;
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  const grouped = new Intl.NumberFormat("en-IN").format(rupees);
  return `${negative ? "-" : ""}${withSymbol ? "₹" : ""}${grouped}.${String(remainder).padStart(2, "0")}`;
}

export function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  });
}

/** CSS class for a guardrail decision or intervention state. */
export function decisionPill(decision: string): string {
  switch (decision) {
    case "PASS": case "APPROVED": case "CONVERTED": return "pill pill-pass";
    case "WARN": case "REQUIRE_APPROVAL": case "PENDING_APPROVAL": return "pill pill-warn";
    case "BLOCK": case "GUARDRAIL_BLOCKED": case "REJECTED": case "EXPIRED": return "pill pill-block";
    case "PROPOSED": return "pill pill-accent";
    default: return "pill pill-muted";
  }
}
