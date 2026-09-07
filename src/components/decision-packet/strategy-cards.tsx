"use client";

import { Sparkles } from "lucide-react";

import { formatPercent, formatRupees } from "@/lib/format";

/**
 * The three scored strategies.
 *
 * Figures are copied verbatim from persisted Estimate rows. Nothing here
 * computes, derives, or re-ranks — the frontend showing a number the estimator
 * did not produce would defeat the point of scoring deterministically.
 */
export interface StrategyView {
  estimateId: string; playbookKey: string; playbookName: string;
  expectedGrossPaise: number; costPaise: number; expectedNetPaise: number;
  pRecoverAvgBps: number; confidence: string; isSelected?: boolean;
}

export function StrategyCards({ strategies }: { strategies: StrategyView[] }) {
  return (
    <div className="strategy-grid">
      {strategies.map((strategy) => (
        <div
          key={strategy.estimateId}
          className={`strategy${strategy.isSelected ? " chosen" : ""}`}
        >
          {strategy.isSelected && (
            <span className="badge badge-ai" style={{ marginBottom: 10 }}>
              <Sparkles />AI selected
            </span>
          )}
          <div className="s-name">{strategy.playbookName}</div>
          <div className="mono">{strategy.playbookKey}</div>
          <div
            className="s-net"
            style={{ color: strategy.isSelected ? "var(--ai-600)" : "var(--ink-900)" }}
          >
            {formatRupees(strategy.expectedNetPaise)}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>expected net</div>

          <div className="s-line"><span>Expected gross</span><span>{formatRupees(strategy.expectedGrossPaise)}</span></div>
          <div className="s-line"><span>Cost</span><span>{formatRupees(strategy.costPaise)}</span></div>
          <div className="s-line"><span>Recovery rate</span><span>{formatPercent(strategy.pRecoverAvgBps)}</span></div>
          <div className="s-line">
            <span>Confidence</span>
            <span><span className="badge badge-neutral">{strategy.confidence}</span></span>
          </div>
        </div>
      ))}
    </div>
  );
}
