"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useRef, useState } from "react";
import {
  Brain, CheckCircle2, Database, CreditCard, ShieldCheck, Target,
} from "lucide-react";

/**
 * Revenue Flow — the command centre's centrepiece.
 *
 * Depth is done with CSS 3D transforms and SVG rather than WebGL. React Three
 * Fiber would have added several hundred kilobytes and a GPU dependency for a
 * diagram that is fundamentally six nodes on a rail: `preserve-3d` with
 * `translateZ`, pointer-driven parallax and animated stroke offsets give the
 * same sense of depth, render identically on a projector or an integrated GPU,
 * and need no fallback path.
 *
 * The lit nodes reflect the agent's REAL position in the pipeline, derived from
 * persisted state. Nothing here animates ahead of what actually happened.
 */
export type FlowPhase =
  | "IDLE" | "OBSERVED" | "REASONED" | "AWAITING_APPROVAL"
  | "APPROVED" | "EXECUTED" | "CONVERTED";

interface FlowNode {
  key: string;
  label: string;
  icon: typeof Database;
  /** Marks the one node that represents model reasoning. */
  ai?: boolean;
}

const NODES: readonly FlowNode[] = [
  { key: "data", label: "Merchant data", icon: Database },
  { key: "opportunity", label: "Opportunity", icon: Target },
  { key: "ai", label: "AI reasoning", icon: Brain, ai: true },
  { key: "guardrail", label: "Guardrails", icon: ShieldCheck },
  { key: "razorpay", label: "Razorpay", icon: CreditCard },
  { key: "revenue", label: "Recovered", icon: CheckCircle2 },
];

/** How far along the rail each phase has genuinely reached. */
const REACHED: Record<FlowPhase, number> = {
  IDLE: 0, OBSERVED: 1, REASONED: 2, AWAITING_APPROVAL: 3,
  APPROVED: 3, EXECUTED: 4, CONVERTED: 5,
};

export function RevenueFlow({
  phase, captions,
}: { phase: FlowPhase; captions: Partial<Record<string, string>> }) {
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  // Pointer parallax. Small angles: the effect should register as depth, not
  // as the page moving under the cursor.
  const onMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const px = (event.clientX - box.left) / box.width - 0.5;
    const py = (event.clientY - box.top) / box.height - 0.5;
    setTilt({ x: -py * 5, y: px * 7 });
  }, [reduced]);

  const reached = REACHED[phase];

  return (
    <div
      className="flow-stage"
      ref={stage}
      onPointerMove={onMove}
      onPointerLeave={() => setTilt({ x: 0, y: 0 })}
    >
      <motion.div
        className="flow-scene"
        animate={{ rotateX: tilt.x, rotateY: tilt.y }}
        transition={{ type: "spring", stiffness: 110, damping: 18 }}
      >
        <div style={{ position: "relative" }}>
          {/* The rail. Its filled portion never runs ahead of the real phase. */}
          <svg
            className="flow-rail"
            viewBox="0 0 100 2"
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{ height: 2 }}
          >
            <line x1="8" y1="1" x2="92" y2="1" stroke="var(--line-strong)" strokeWidth="1.6" />
            <motion.line
              x1="8" y1="1" x2="92" y2="1"
              stroke="url(#flowGrad)" strokeWidth="1.6" strokeLinecap="round"
              initial={false}
              animate={{ pathLength: reached / (NODES.length - 1) }}
              transition={{ duration: reduced ? 0 : 0.9, ease: [0.22, 0.68, 0.32, 1] }}
            />
            <defs>
              <linearGradient id="flowGrad" x1="0" x2="1">
                <stop offset="0%" stopColor="var(--blue-500)" />
                <stop offset="55%" stopColor="var(--ai-500)" />
                <stop offset="100%" stopColor="var(--ok-500)" />
              </linearGradient>
            </defs>
          </svg>

          <div className="flow-nodes">
            {NODES.map((node, index) => {
              const done = index < reached;
              const active = index === reached && phase !== "CONVERTED";
              const lit = index <= reached;
              const Icon = node.icon;
              return (
                <motion.div
                  key={node.key}
                  className={[
                    "flow-node",
                    node.ai ? "ai" : "",
                    done ? "done" : "",
                    active ? "active" : "",
                  ].join(" ")}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{
                    opacity: lit ? 1 : 0.44,
                    y: 0,
                    // Lit nodes sit forward in space; unlit ones recede.
                    z: lit ? 18 : 0,
                  }}
                  transition={{ delay: reduced ? 0 : index * 0.07, duration: 0.45 }}
                >
                  <div className="orb">
                    <Icon strokeWidth={2.1} />
                  </div>
                  <div className="n-title">{node.label}</div>
                  <div className="n-sub">{captions[node.key] ?? "—"}</div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </motion.div>

      <div className="flow-legend">
        <span className="badge badge-blue">Deterministic</span>
        <span className="badge badge-ai">AI reasoning</span>
        <span className="badge badge-ok">Verified outcome</span>
        <span style={{ marginLeft: "auto" }}>
          Lit stages reflect this session&apos;s actual progress
        </span>
      </div>
    </div>
  );
}
