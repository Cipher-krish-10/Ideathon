"use client";

import { ArrowRight, Filter, Target, XCircle } from "lucide-react";

/**
 * The detector's headline, shown as a transformation rather than a total.
 *
 * The gap between "66 failed" and "26 qualified" is the product's real claim —
 * the agent discriminated. A single number would hide exactly the thing worth
 * showing.
 */
export function OpportunityHero({
  failedTransactions, qualifying, customers, valueLabel,
}: {
  failedTransactions: number;
  qualifying: number;
  customers: number;
  valueLabel: string;
}) {
  const steps = [
    { icon: XCircle, value: failedTransactions, label: "failed transactions", tone: "" },
    { icon: Filter, value: qualifying, label: "qualified after screening", tone: "blue" },
    { icon: Target, value: valueLabel, label: `recoverable · ${customers} customers`, tone: "ok" },
  ] as const;

  return (
    <div className="row" style={{ gap: 0, alignItems: "stretch", flexWrap: "nowrap", overflowX: "auto" }}>
      {steps.map((step, index) => {
        const Icon = step.icon;
        return (
          <div
            key={step.label}
            style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexShrink: 0 }}
          >
            <div style={{ minWidth: 132 }}>
              <div className="row" style={{ gap: 7, marginBottom: 5 }}>
                <Icon
                  size={15}
                  strokeWidth={2.2}
                  color={
                    step.tone === "ok" ? "var(--ok-600)"
                    : step.tone === "blue" ? "var(--blue-600)" : "var(--ink-300)"
                  }
                />
                <span
                  style={{
                    fontSize: step.tone === "ok" ? 26 : 22,
                    fontWeight: 660,
                    letterSpacing: "-.03em",
                    fontVariantNumeric: "tabular-nums",
                    color:
                      step.tone === "ok" ? "var(--ok-600)"
                      : step.tone === "blue" ? "var(--blue-700)" : "var(--ink-500)",
                  }}
                >
                  {step.value}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-400)" }}>{step.label}</div>
            </div>
            {index < steps.length - 1 && (
              <ArrowRight size={16} color="var(--ink-300)" style={{ margin: "0 var(--s-4)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
