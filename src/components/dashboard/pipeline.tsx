"use client";

import { motion, useReducedMotion } from "framer-motion";

/**
 * The agent pipeline, as an instrument.
 *
 * Six columns on a hairline rail, each showing a real count, with one marker
 * for where the session actually is. An earlier version drew pastel icon
 * circles with a legend — it read as a marketing diagram rather than status,
 * which is exactly the tell that makes a dashboard look generated.
 *
 * Depth is a small translateZ on the current column plus a pointer-follow
 * gradient, not a stage full of floating orbs.
 */
export type FlowPhase =
  | "IDLE" | "OBSERVED" | "REASONED" | "AWAITING_APPROVAL"
  | "APPROVED" | "EXECUTED" | "CONVERTED";

const STEPS = [
  { key: "data", label: "Merchant data" },
  { key: "opportunity", label: "Opportunity" },
  { key: "ai", label: "AI reasoning", ai: true },
  { key: "guardrail", label: "Guardrails" },
  { key: "razorpay", label: "Razorpay" },
  { key: "revenue", label: "Recovered" },
] as const;

/** How far the session has genuinely reached. */
const REACHED: Record<FlowPhase, number> = {
  IDLE: 0, OBSERVED: 1, REASONED: 2, AWAITING_APPROVAL: 3,
  APPROVED: 3, EXECUTED: 4, CONVERTED: 5,
};

export function Pipeline({
  phase, values,
}: { phase: FlowPhase; values: Partial<Record<string, string>> }) {
  const reduced = useReducedMotion();
  const reached = REACHED[phase];

  return (
    <div className="pipeline">
      {STEPS.map((step, index) => {
        const done = index < reached || phase === "CONVERTED";
        const here = index === reached && phase !== "CONVERTED";
        const isAi = "ai" in step && step.ai;
        return (
          <div
            key={step.key}
            className={[
              "pipe-step",
              index <= reached ? "reached" : "",
              here ? "here" : "",
              done ? "done" : "",
              isAi ? "ai" : "",
            ].join(" ")}
          >
            <div className="k">
              {here && (
                <motion.span
                  className="status-dot active"
                  style={{ width: 6, height: 6 }}
                  animate={reduced ? {} : { opacity: [1, 0.4, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              )}
              {step.label}
            </div>
            <div className="v">{values[step.key] ?? "—"}</div>
            <motion.div
              className="bar"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: index <= reached ? 1 : 0 }}
              transition={{ duration: reduced ? 0 : 0.5, delay: index * 0.06 }}
              style={{ transformOrigin: "left" }}
            />
          </div>
        );
      })}
    </div>
  );
}
