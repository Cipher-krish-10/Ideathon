"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Merchant revenue flow — the agent, drawn as infrastructure.
 *
 * A spatial scene, not a chart. The camera sits slightly above a ground plane
 * and looks along a path that sweeps away through space and returns; the six
 * stages of the agent are gates along that path. Money and data move through
 * it as particles.
 *
 *   MERCHANT DATA → DETECTION → AI DECISION → POLICY GATE → RAZORPAY → REVENUE
 *
 * WHAT MAKES IT SPATIAL
 * ---------------------
 * Real 3D, not layered 2D. Points live in world space, are rotated by the
 * camera's pitch, then perspective-divided. From that one transform we get,
 * consistently: gates at genuinely different depths, a path that narrows as it
 * recedes, particles that shrink and fade with distance, a ground plane whose
 * grid converges, and contact shadows dropped straight down onto that ground.
 *
 * Each gate's world x is solved so that AFTER the perspective divide it lands
 * on the centre of its own label column. Without that the scene drifts from
 * its labels and stops being a diagram.
 *
 * WHY NOT WebGL
 * -------------
 * Six gates, one ribbon and ~60 particles do not need a GPU pipeline, and
 * three.js would add roughly 600KB to a page whose whole job is to be read
 * quickly. WebGL also fails hard in exactly the places this gets demoed —
 * remote desktops, VMs, locked-down browsers — and a dead rectangle in the
 * middle of the console is worse than anything it buys. Canvas 2D is universal
 * and does everything this scene needs. If even the 2D context is missing,
 * `ready` stays false and the CSS fallback renders.
 *
 * MOTION IS STATE, NEVER DECORATION
 * ---------------------------------
 * Nothing moves that the application has not actually done. Particle
 * population is bounded by how far the session genuinely reached; flow stalls
 * amber at the policy gate while a human decision is outstanding; a conversion
 * sends a green signal backward through the system, followed by a loop
 * settling on the AI gate — the learning write, actually happening.
 */

export type FlowPhase =
  | "IDLE" | "OBSERVED" | "REASONED" | "AWAITING_APPROVAL" | "BLOCKED"
  | "APPROVED" | "EXECUTED" | "CONVERTED" | "LEARNED";

export const FLOW_STAGES = [
  { key: "data",        label: "Merchant data" },
  { key: "opportunity", label: "Detection" },
  { key: "ai",          label: "AI decision", ai: true },
  { key: "guardrail",   label: "Policy gate" },
  { key: "razorpay",    label: "Razorpay" },
  { key: "revenue",     label: "Revenue" },
] as const;

/** How far the session has genuinely reached. Derived from persisted state. */
const REACHED: Record<FlowPhase, number> = {
  IDLE: 0, OBSERVED: 1, REASONED: 2, AWAITING_APPROVAL: 3,
  // A blocked proposal REACHED the policy gate and was refused there. Stopping
  // the frontier at the AI stage would understate what actually happened: the
  // controls ran, and they said no.
  BLOCKED: 3,
  APPROVED: 3, EXECUTED: 4, CONVERTED: 5, LEARNED: 5,
};

const N = FLOW_STAGES.length;
const LAST = N - 1;

/* ------------------------------------------------------------- geometry -- */

interface Vec3 { x: number; y: number; z: number }

/** Camera pitch in radians — slightly above the plane, looking down it. */
const PITCH = 0.30;
const FOCAL = 3.05;
const SIN_P = Math.sin(PITCH);
const COS_P = Math.cos(PITCH);

/** The ground plane, below the path. */
const GROUND_Y = 0.42;

/**
 * The route through world space.
 *
 * `u` runs 0..1 from merchant data to recovered revenue. It sweeps away from
 * the camera through the middle of the run and returns, so the agent's
 * decision stages sit furthest into the scene — which is also where the actual
 * work is.
 */
function pathPoint(u: number): Vec3 {
  return {
    x: (u - 0.5) * 2.0,
    y: Math.sin(u * Math.PI) * -0.46 + Math.sin(u * Math.PI * 2) * 0.04,
    z: Math.sin(u * Math.PI) * 1.15,
  };
}

export function RevenueFlow({
  phase, values, className,
}: {
  phase: FlowPhase;
  values: Partial<Record<string, string>>;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  // The loop reads the phase through a ref so a state change does not tear
  // down and restart the scene. Synced in an effect, never during render.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const reached = REACHED[phase];

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const context = canvas.getContext("2d");
    if (!context) return;   // the CSS fallback stays visible
    setReady(true);

    const styles = getComputedStyle(wrap);
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;

    const C = {
      line:   token("--line", "#e6e9ef"),
      soft:   token("--line-soft", "#eef0f4"),
      dim:    token("--ink-200", "#c9d0da"),
      blue:   token("--blue-500", "#2b73ea"),
      ai:     token("--ai-500", "#6d51e0"),
      ok:     token("--ok-500", "#0f9d58"),
      warn:   token("--warn-500", "#b87503"),
      stop:   token("--stop-500", "#d33c31"),
      canvas: token("--surface", "#ffffff"),
    };

    let W = 0, H = 0, raf = 0, running = true;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    /* --- camera ---------------------------------------------------------- */
    interface Projected { x: number; y: number; s: number }

    const project = (p: Vec3): Projected => {
      // Pitch the world about X, then perspective-divide.
      const y = p.y * COS_P - p.z * SIN_P;
      const z = p.y * SIN_P + p.z * COS_P;
      const s = FOCAL / (FOCAL + z);
      return { x: W / 2 + p.x * s * (W * 0.5), y: H * 0.66 + y * s * (H * 0.86), s };
    };

    /**
     * World x for a gate, solved so it projects onto its label column. Depth
     * is known before x, so this is exact rather than fitted.
     */
    const gateAt = (index: number): Vec3 => {
      const u = index / LAST;
      const base = pathPoint(u);
      const z = base.y * SIN_P + base.z * COS_P;
      const s = FOCAL / (FOCAL + z);
      const column = (index + 0.5) / N;
      return { ...base, x: (column - 0.5) / (s * 0.5) };
    };

    const gates: Vec3[] = Array.from({ length: N }, (_, i) => gateAt(i));

    /**
     * The route, resampled to pass exactly through the solved gates. Between
     * them it eases along the original sweep, so the curve stays smooth while
     * the gates stay locked to their labels.
     */
    const curveAt = (u: number): Vec3 => {
      const t = Math.min(Math.max(u, 0), 1) * LAST;
      const i = Math.min(Math.floor(t), LAST - 1);
      const f = t - i;
      const e = f * f * (3 - 2 * f);          // smoothstep: no corner at a gate
      const a = gates[i]!, b = gates[i + 1]!;
      const base = pathPoint(Math.min(Math.max(u, 0), 1));
      return { x: a.x + (b.x - a.x) * e, y: base.y, z: base.z };
    };

    /* --- particles -------------------------------------------------------- */
    interface Particle { u: number; speed: number; lane: number; size: number }

    const particles: Particle[] = [];
    const spawn = (frontier: number): Particle => ({
      u: Math.random() * Math.max(frontier / LAST, 0.001),
      speed: 0.0013 + Math.random() * 0.0016,
      lane: (Math.random() - 0.5) * 0.10,
      size: 1.3 + Math.random() * 1.7,
    });

    /** Backward success signal, and the learning loop that follows it. */
    let signal = -1;
    let signalAt = 0;
    let loop = -1;

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const frame = (now: number) => {
      if (!running) return;
      const reduced = reducedQuery.matches;
      const current = phaseRef.current;
      const front = REACHED[current];
      const converted = current === "CONVERTED" || current === "LEARNED";
      const gated = current === "AWAITING_APPROVAL";
      const stopped = current === "BLOCKED";
      const frontU = front / LAST;

      context.clearRect(0, 0, W, H);

      /* --- ground plane --------------------------------------------------
         A converging grid is the cheapest honest depth cue there is: it
         establishes the space before anything is drawn into it. */
      context.lineWidth = 1;
      for (let i = 0; i <= N; i += 1) {
        const x = (i / N - 0.5) * 2.2;
        const a = project({ x, y: GROUND_Y, z: -0.35 });
        const b = project({ x, y: GROUND_Y, z: 1.5 });
        const gradient = context.createLinearGradient(a.x, a.y, b.x, b.y);
        gradient.addColorStop(0, C.line);
        gradient.addColorStop(0.55, C.soft);
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        context.strokeStyle = gradient;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      for (let i = 0; i <= 4; i += 1) {
        const z = -0.35 + (i / 4) * 1.85;
        const a = project({ x: -1.1, y: GROUND_Y, z });
        const b = project({ x: 1.1, y: GROUND_Y, z });
        context.strokeStyle = C.line;
        context.globalAlpha = 0.9 - i * 0.2;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      context.globalAlpha = 1;

      /* --- contact shadows -------------------------------------------------
         Each gate drops straight down onto the plane. This is what stops them
         reading as stickers on a background. */
      gates.forEach((gate, index) => {
        const ground = project({ x: gate.x, y: GROUND_Y, z: gate.z });
        const rx = 17 * ground.s;
        const shade = context.createRadialGradient(ground.x, ground.y, 0, ground.x, ground.y, rx);
        shade.addColorStop(0, `rgba(10,14,23,${index <= front ? 0.22 : 0.11})`);
        shade.addColorStop(1, "rgba(10,14,23,0)");
        context.fillStyle = shade;
        context.beginPath();
        context.ellipse(ground.x, ground.y, rx, 3.4 * ground.s, 0, 0, Math.PI * 2);
        context.fill();
      });

      /* --- the route -------------------------------------------------------
         Two passes: the whole system in a hairline so it is always legible,
         then the portion actually traversed, in the colour of the real state. */
      const SAMPLES = 160;
      const drawPath = (toU: number, colour: string, width: number, alpha: number) => {
        context.beginPath();
        for (let i = 0; i <= SAMPLES; i += 1) {
          const p = project(curveAt((toU * i) / SAMPLES));
          if (i === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
        }
        context.strokeStyle = colour;
        context.globalAlpha = alpha;
        context.lineWidth = width;
        context.lineCap = "round";
        context.stroke();
        context.globalAlpha = 1;
      };

      drawPath(1, C.dim, 1.25, 0.75);
      if (front > 0) {
        const live = converted ? C.ok : stopped ? C.stop : gated ? C.warn : C.blue;
        drawPath(frontU, live, 5, 0.10);      // soft halo under the live run
        drawPath(frontU, live, 1.8, 0.55);
      }

      /* --- particles -------------------------------------------------------- */
      const wanted = reduced ? 0 : Math.min(front * 11, 58);
      while (particles.length < wanted) particles.push(spawn(front));
      while (particles.length > wanted) particles.pop();

      interface Dot { x: number; y: number; r: number; a: number; c: string; tx: number; ty: number }
      const dots: Dot[] = [];
      const gateU = 3 / LAST;

      for (const particle of particles) {
        if (!reduced) particle.u += particle.speed;

        // The policy gate is a real stop: work queues there and waits for a
        // human, rather than flowing through as if approval were automatic.
        // Both a pending decision and a refusal stop the flow at the gate.
        if ((gated || stopped) && particle.u > gateU) {
          particle.u = gateU - Math.random() * 0.012;
        }
        if (particle.u > frontU) particle.u = 0;

        const previous = Math.max(particle.u - particle.speed * 7, 0);
        const here = curveAt(particle.u);
        const back = curveAt(previous);
        const p = project({ ...here, y: here.y + particle.lane });
        const q = project({ ...back, y: back.y + particle.lane });

        // Atmosphere: distant particles are smaller and fainter.
        const alpha = Math.min(Math.max((p.s - 0.66) * 2.3, 0.12), 0.9);
        const nearGate = (gated || stopped) && particle.u > gateU - 0.05;
        const colour =
          converted ? C.ok
          : nearGate ? (stopped ? C.stop : C.warn)
          : particle.u > 1.6 / LAST && particle.u < 2.6 / LAST ? C.ai
          : C.blue;

        dots.push({ x: p.x, y: p.y, r: particle.size * p.s, a: alpha, c: colour, tx: q.x, ty: q.y });
      }

      // Painter's algorithm: far particles first, near ones in front.
      dots.sort((a, b) => a.r - b.r);
      for (const dot of dots) {
        context.strokeStyle = dot.c;
        context.globalAlpha = dot.a * 0.34;
        context.lineWidth = dot.r * 1.25;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(dot.tx, dot.ty);
        context.lineTo(dot.x, dot.y);
        context.stroke();

        context.globalAlpha = dot.a;
        context.fillStyle = dot.c;
        context.beginPath();
        context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;

      /* --- conversion signal, travelling backward --------------------------
         A verified payment is news the whole system needs: it propagates back
         up the route, then a loop settles on the AI gate — the learning write. */
      if (converted && !reduced) {
        if (signal < 0 && loop < 0 && now - signalAt > 3200) { signal = 1; signalAt = now; }
        if (signal >= 0) {
          signal -= 0.009;
          if (signal <= 0) { signal = -1; loop = 1; }
          else {
            const p = project(curveAt(signal));
            const glow = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26 * p.s);
            glow.addColorStop(0, "rgba(15,157,88,.30)");
            glow.addColorStop(1, "rgba(15,157,88,0)");
            context.fillStyle = glow;
            context.beginPath();
            context.arc(p.x, p.y, 26 * p.s, 0, Math.PI * 2);
            context.fill();
          }
        }
        if (loop >= 0) {
          loop -= 0.02;
          if (loop <= 0) loop = -1;
          else {
            const ai = project(gates[2]!);
            context.strokeStyle = C.ai;
            context.globalAlpha = loop * 0.5;
            context.lineWidth = 1.4;
            context.beginPath();
            context.arc(ai.x, ai.y, (10 + (1 - loop) * 16) * ai.s, 0, Math.PI * 2);
            context.stroke();
            context.globalAlpha = 1;
          }
        }
      }

      /* --- gates ------------------------------------------------------------
         Rings, not dots. A ring reads as something the flow passes THROUGH,
         which is exactly what each of these stages is. */
      gates.forEach((gate, index) => {
        const p = project(gate);
        const isHere = index === front && !converted;
        const isPast = index < front || converted;
        const isAi = index === 2;
        const r = 10 * p.s;

        const colour =
          converted ? C.ok
          : isHere && stopped ? C.stop
          : isHere && gated ? C.warn
          : isHere ? (isAi ? C.ai : C.blue)
          : isPast ? (isAi ? C.ai : C.blue)
          : C.dim;

        if (isHere && !reduced) {
          // One breathing halo, on the single gate the session is actually at.
          const breathe = 0.5 + 0.5 * Math.sin(now / 700);
          const halo = context.createRadialGradient(p.x, p.y, r, p.x, p.y, r + 16 + breathe * 7);
          halo.addColorStop(0, `${colour}2e`);
          halo.addColorStop(1, "rgba(255,255,255,0)");
          context.fillStyle = halo;
          context.beginPath();
          context.arc(p.x, p.y, r + 16 + breathe * 7, 0, Math.PI * 2);
          context.fill();
        }

        context.beginPath();
        context.arc(p.x, p.y, r, 0, Math.PI * 2);
        context.fillStyle = C.canvas;
        context.fill();
        context.strokeStyle = colour;
        context.lineWidth = isPast || isHere ? 2 : 1.2;
        context.globalAlpha = isPast || isHere ? 1 : 0.8;
        context.stroke();
        context.globalAlpha = 1;

        if (isPast || isHere) {
          context.beginPath();
          context.arc(p.x, p.y, r * 0.42, 0, Math.PI * 2);
          context.fillStyle = colour;
          context.fill();
        }
      });

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    // An off-screen animation loop burns battery for nobody.
    const onVisibility = () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else if (!running) { running = true; raf = requestAnimationFrame(frame); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className={`flow${className ? ` ${className}` : ""}`}>
      <div className="flow-scene" ref={wrapRef}>
        <canvas className="flow-canvas" ref={canvasRef} aria-hidden="true" />
        {/* Same six stages, no motion. Visible until the canvas reports it can
            actually draw. */}
        {!ready && (
          <div className="flow-fallback" aria-hidden="true">
            {FLOW_STAGES.map((stage, index) => (
              <span key={stage.key} className={index <= reached ? "on" : ""} />
            ))}
          </div>
        )}
      </div>

      {/* The information itself: real DOM, always present, canvas or not. */}
      <ol className="flow-stages">
        {FLOW_STAGES.map((stage, index) => {
          const isAi = "ai" in stage && stage.ai;
          const here = index === reached && phase !== "CONVERTED" && phase !== "LEARNED";
          return (
            <li
              key={stage.key}
              className={[
                "flow-stage",
                index <= reached ? "reached" : "",
                here ? "here" : "",
                isAi ? "ai" : "",
                here && phase === "BLOCKED" ? "stopped" : "",
              ].join(" ")}
            >
              <span className="fs-name">{stage.label}</span>
              <span className="fs-value">{values[stage.key] ?? "—"}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
