"use client";

import { motion } from "framer-motion";
import { ArrowDown } from "lucide-react";

/**
 * Recovery funnel.
 *
 * Bar widths are proportional to the counts the server supplied. Nothing is
 * recomputed here, and a stage never renders wider than the one above it.
 */
export function FunnelChart({
  stages, blocked, rejected,
}: {
  stages: { label: string; count: number; meaning: string }[];
  blocked: number;
  rejected: number;
}) {
  const max = Math.max(...stages.map((stage) => stage.count), 1);

  return (
    <div>
      {stages.map((stage, index) => {
        const pct = Math.max((stage.count / max) * 100, stage.count > 0 ? 6 : 2);
        const isLast = index === stages.length - 1;
        return (
          <div key={stage.label}>
            <div className="row" style={{ gap: 14, alignItems: "center" }}>
              <div style={{ minWidth: 92, fontSize: 13, fontWeight: 550 }}>{stage.label}</div>
              <div style={{ flex: 1, height: 34, position: "relative" }}>
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.65, delay: index * 0.08, ease: [0.22, 0.68, 0.32, 1] }}
                  style={{
                    height: "100%", borderRadius: "var(--r-md)",
                    background: isLast
                      ? "linear-gradient(90deg, var(--ok-500), #35c07a)"
                      : `linear-gradient(90deg, var(--blue-500), var(--ai-500) ${60 + index * 8}%)`,
                    opacity: stage.count === 0 ? 0.22 : 1 - index * 0.09,
                    display: "flex", alignItems: "center", paddingLeft: 12,
                    color: "#fff", fontWeight: 640, fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {stage.count}
                </motion.div>
              </div>
              <div className="muted" style={{ fontSize: 12, minWidth: 190 }}>{stage.meaning}</div>
            </div>
            {!isLast && (
              <div style={{ paddingLeft: 106, height: 14 }}>
                <ArrowDown size={13} color="var(--ink-300)" />
              </div>
            )}
          </div>
        );
      })}

      <div className="row" style={{ gap: 10, marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
        <span className="badge badge-stop">Blocked by guardrails · {blocked}</span>
        <span className="badge badge-neutral">Rejected by a human · {rejected}</span>
      </div>
    </div>
  );
}
