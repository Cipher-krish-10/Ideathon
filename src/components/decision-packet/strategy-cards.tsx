"use client";

import { Sparkles } from "lucide-react";

import { formatPercent, formatRupees } from "@/lib/format";

/**
 * Strategy comparison.
 *
 * A matrix, because the merchant's actual question is "which of these is
 * better, and by how much" — and that is a table question. Three large cards
 * force the reader to compare figures across whitespace instead of down a
 * column, which is slower and reads as a pricing page.
 *
 * Every figure is copied verbatim from a persisted Estimate row. Nothing here
 * computes, derives or re-ranks: the bar widths are the only thing this
 * component calculates, and they are pure presentation of the same numbers.
 */
export interface StrategyView {
  estimateId: string; playbookKey: string; playbookName: string;
  expectedGrossPaise: number; costPaise: number; expectedNetPaise: number;
  pRecoverAvgBps: number; confidence: string; isSelected?: boolean;
}

export function StrategyCards({ strategies }: { strategies: StrategyView[] }) {
  const best = Math.max(...strategies.map((s) => s.expectedNetPaise), 1);

  return (
    <div className="table-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>Strategy</th>
            <th className="num">Expected gross</th>
            <th className="num">Cost</th>
            <th className="num">Expected net</th>
            <th className="num">Recovery rate</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((strategy) => (
            <tr
              key={strategy.estimateId}
              className={`strategy${strategy.isSelected ? " chosen" : ""}`}
            >
              <td>
                <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="s-name">{strategy.playbookName}</span>
                    <span className="s-key" style={{ display: "block" }}>{strategy.playbookKey}</span>
                  </span>
                  {strategy.isSelected && (
                    <span className="badge badge-ai"><Sparkles />AI selected</span>
                  )}
                </div>
              </td>
              <td className="num mono">{formatRupees(strategy.expectedGrossPaise)}</td>
              <td className="num mono">{formatRupees(strategy.costPaise)}</td>
              <td className="num">
                <span className="s-net">{formatRupees(strategy.expectedNetPaise)}</span>
                {/* Proportional to the best option, so ranking is visible
                    without arithmetic. Presentation only. */}
                <span className="net-bar">
                  <i style={{ width: `${Math.max((strategy.expectedNetPaise / best) * 100, 2)}%` }} />
                </span>
              </td>
              <td className="num mono">{formatPercent(strategy.pRecoverAvgBps)}</td>
              <td><span className="badge badge-neutral">{strategy.confidence}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
