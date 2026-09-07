"use client";

import { useEffect, useRef } from "react";
import { Brain, CreditCard, Database, ShieldCheck, Target, TrendingUp } from "lucide-react";

/**
 * Merchant revenue flow.
 *
 * The one place in the product with real depth, and it earns it by carrying
 * meaning: this is the agent's actual architecture, and what moves through it
 * is what the session has actually done.
 *
 *   MERCHANT DATA → DETECTION → AI REASONING → GUARDRAILS → RAZORPAY → RECOVERED
 *
 * Implementation notes
 * --------------------
 * Nodes live at real 3D coordinates and are perspective-projected onto a 2D
 * canvas each frame; particles interpolate along the 3D path between them and
 * are depth-sorted, so near particles are larger, brighter and drawn last.
 * That is genuine perspective, not a parallax trick.
 *
 * Deliberately NOT WebGL. A 600KB renderer for six nodes and a few dozen
 * particles is a bad trade, and WebGL fails hard in exactly the environments a
 * demo runs in — remote desktops, VMs, locked-down browsers. Canvas 2D is
 * universally available, and if even that is missing the stage labels below
 * still carry every number.
 *
 * The labels are real DOM, never painted into the canvas: they must stay
 * crisp, selectable, translatable and readable by assistive tech.
 */

export type FlowPhase =
  | "IDLE" | "OBSERVED" | "REASONED" | "AWAITING_APPROVAL"
  | "APPROVED" | "EXECUTED" | "CONVERTED";

const STAGES = [
  { key: "data",        label: "Merchant data", icon: Database },
  { key: "opportunity", label: "Detection",     icon: Target },
  { key: "ai",          label: "AI reasoning",  icon: Brain, ai: true },
  { key: "guardrail",   label: "Guardrails",    icon: ShieldCheck },
  { key: "razorpay",    label: "Razorpay",      icon: CreditCard },
  { key: "revenue",     label: "Recovered",     icon: TrendingUp },
] as const;

/** How far the session has genuinely reached. Derived from persisted state. */
const REACHED: Record<FlowPhase, number> = {
  IDLE: 0, OBSERVED: 1, REASONED: 2, AWAITING_APPROVAL: 3,
  APPROVED: 3, EXECUTED: 4, CONVERTED: 5,
};

/* --- palette, read once from the stylesheet so the canvas cannot drift ---- */
interface Palette {
  line: string; ink: string; dim: string; blue: string; ai: string; ok: string; warn: string;
}

function readPalette(el: HTMLElement): Palette {
  const style = getComputedStyle(el);
  const get = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    line: get("--line", "#e6e9ef"),
    ink:  get("--ink-300", "#a8b2c1"),
    dim:  get("--line-soft", "#eef0f4"),
    blue: get("--blue-500", "#2b73ea"),
    ai:   get("--ai-500", "#6d51e0"),
    ok:   get("--ok-500", "#0f9d58"),
    warn: get("--warn-500", "#b87503"),
  };
}

interface Particle {
  /** Segment index the particle is travelling along. */
  seg: number;
  /** Progress through that segment, 0..1. */
  t: number;
  speed: number;
  /** Lateral offset so particles form a bundle, not a single line. */
  offset: number;
  size: number;
}

export function RevenueFlow({
  phase, values, title = "Revenue flow",
}: {
  phase: FlowPhase;
  values: Partial<Record<string, string>>;
  title?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The animation loop reads the phase through a ref so a phase change does
  // not tear down and restart the canvas. Synced in an effect, never during
  // render.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const reached = REACHED[phase];

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const context = canvas.getContext("2d");
    // No 2D context (very old or heavily locked-down browser): the stage
    // labels below already carry the information, so simply draw nothing.
    if (!context) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const palette = readPalette(wrap);

    let width = 0;
    let height = 0;
    let raf = 0;
    let running = true;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    /* --- 3D scene ---------------------------------------------------------
       Six nodes on an arc that swings away from the camera through the middle
       of the run and returns, so the row reads as a path through space rather
       than a line of circles.

       Each node's x is solved so that AFTER perspective division it lands on
       the centre of its own stage column below. Without that the nodes drift
       away from their labels and the whole thing stops being a diagram and
       becomes decoration. */
    const FOCAL = 3.2;
    const COUNT = STAGES.length;

    const nodes3d = STAGES.map((_, index) => {
      const u = index / (COUNT - 1);                 // 0..1 across the run
      const z = Math.sin(u * Math.PI) * 0.62;        // arc away from the camera
      const scale = FOCAL / (FOCAL + z);
      // Column centre this node must project onto, as a fraction of width.
      const column = (index + 0.5) / COUNT;
      return {
        x: (column - 0.5) / (scale * 0.5),
        y: Math.sin(u * Math.PI) * -0.62,            // lift through the middle
        z,
      };
    });

    const project = (p: { x: number; y: number; z: number }) => {
      const scale = FOCAL / (FOCAL + p.z);
      return {
        x: width / 2 + p.x * scale * (width * 0.5),
        y: height * 0.80 + p.y * scale * (height * 0.72),
        scale,
      };
    };

    const lerp3 = (a: typeof nodes3d[0], b: typeof nodes3d[0], t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });

    /* --- particles -------------------------------------------------------- */
    const particles: Particle[] = [];
    const spawn = (seg: number): Particle => ({
      seg,
      t: Math.random(),
      speed: 0.0016 + Math.random() * 0.0022,
      offset: (Math.random() - 0.5) * 0.075,
      size: 1.5 + Math.random() * 1.8,
    });

    /** Pulse travelling backward through the system after a conversion. */
    let pulse = -1;
    let lastPulseAt = 0;

    const frame = (now: number) => {
      if (!running) return;
      const currentPhase = phaseRef.current;
      const front = REACHED[currentPhase];
      const converted = currentPhase === "CONVERTED";
      // Approval is a genuine stop: flow reaches the gate and waits there.
      const gated = currentPhase === "AWAITING_APPROVAL";

      context.clearRect(0, 0, width, height);

      /* --- leader lines: tie each node to the stage column it labels ------ */
      nodes3d.forEach((node) => {
        const projected = project(node);
        context.beginPath();
        context.moveTo(projected.x, projected.y);
        context.lineTo(projected.x, height);
        context.strokeStyle = palette.line;
        context.lineWidth = 1;
        context.stroke();
      });

      /* --- rails: every segment, dim ahead of the frontier ---------------- */
      for (let i = 0; i < nodes3d.length - 1; i += 1) {
        const from = project(nodes3d[i]!);
        const to = project(nodes3d[i + 1]!);
        const live = i < front;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = live ? palette.line : palette.dim;
        context.lineWidth = live ? 1.4 : 1;
        context.stroke();
      }

      /* --- particles ------------------------------------------------------
         Population tracks how far the session actually is: no fabricated
         activity ahead of the frontier, and nothing moving at all when the
         agent has not run. */
      const wanted = reduced ? 0 : Math.min(front * 7, 34);
      while (particles.length < wanted) {
        particles.push(spawn(Math.floor(Math.random() * Math.max(front, 1))));
      }
      while (particles.length > wanted) particles.pop();

      const drawn: { x: number; y: number; r: number; a: number; color: string }[] = [];

      for (const particle of particles) {
        if (particle.seg >= front) { particle.seg = 0; particle.t = 0; }
        particle.t += particle.speed * (reduced ? 0 : 1);

        // At the approval gate the queue stalls rather than flowing through.
        const atGate = gated && particle.seg === front - 1;
        if (particle.t >= 1) {
          if (atGate) {
            particle.t = 0.985 + Math.random() * 0.012;
          } else {
            particle.t = 0;
            particle.seg = particle.seg + 1 >= front ? 0 : particle.seg + 1;
          }
        }

        const a = nodes3d[particle.seg]!;
        const b = nodes3d[particle.seg + 1]!;
        if (!b) continue;
        const point = lerp3(a, b, particle.t);
        const projected = project({ ...point, y: point.y + particle.offset });

        // Perspective: near particles are larger and more opaque.
        const depth = projected.scale;
        const alpha = Math.min(0.28 + (depth - 0.72) * 1.9, 0.95);
        const color =
          converted ? palette.ok
          : particle.seg === 2 ? palette.ai
          : atGate ? palette.warn
          : palette.blue;

        drawn.push({
          x: projected.x, y: projected.y,
          r: particle.size * depth, a: Math.max(alpha, 0.1), color,
        });
      }

      // Depth-sort so nearer particles paint over farther ones.
      drawn.sort((p, q) => p.r - q.r);
      for (const dot of drawn) {
        context.beginPath();
        context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
        context.fillStyle = dot.color;
        context.globalAlpha = dot.a;
        context.fill();
      }
      context.globalAlpha = 1;

      /* --- conversion pulse, travelling backward -------------------------- */
      if (converted && !reduced) {
        if (pulse < 0 && now - lastPulseAt > 2600) { pulse = 1; lastPulseAt = now; }
        if (pulse >= 0) {
          pulse -= 0.006;
          if (pulse <= 0) pulse = -1;
          else {
            const index = pulse * (nodes3d.length - 1);
            const i = Math.floor(index);
            const point = lerp3(nodes3d[i]!, nodes3d[Math.min(i + 1, nodes3d.length - 1)]!, index - i);
            const projected = project(point);
            context.beginPath();
            context.arc(projected.x, projected.y, 16 * projected.scale, 0, Math.PI * 2);
            context.fillStyle = palette.ok;
            context.globalAlpha = 0.10;
            context.fill();
            context.globalAlpha = 1;
          }
        }
      }

      /* --- nodes ----------------------------------------------------------- */
      nodes3d.forEach((node, index) => {
        const projected = project(node);
        const isFront = index === front;
        const isPast = index < front;
        const isAi = index === 2;
        const radius = 9.5 * projected.scale;

        const color =
          converted ? palette.ok
          : isFront && gated ? palette.warn
          : isFront ? (isAi ? palette.ai : palette.blue)
          : isPast ? palette.ink
          : palette.ink;

        // A soft halo marks where the session actually is, once.
        if (isFront && !reduced) {
          const breathe = 0.5 + 0.5 * Math.sin(now / 620);
          context.beginPath();
          context.arc(projected.x, projected.y, radius + 7 + breathe * 4, 0, Math.PI * 2);
          context.fillStyle = color;
          context.globalAlpha = 0.10 + breathe * 0.06;
          context.fill();
          context.globalAlpha = 1;
        }

        context.beginPath();
        context.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
        context.fillStyle = isPast || isFront || converted ? color : "#ffffff";
        context.globalAlpha = isPast && !converted ? 0.5 : 1;
        context.fill();
        context.globalAlpha = 1;
        context.lineWidth = 1.5;
        context.strokeStyle = isPast || isFront || converted ? color : palette.line;
        context.stroke();

        // A white core turns the marker into a ring, which reads as a node in
        // a system rather than a bullet point.
        if (isFront || converted) {
          context.beginPath();
          context.arc(projected.x, projected.y, radius * 0.42, 0, Math.PI * 2);
          context.fillStyle = "#ffffff";
          context.fill();
        }
      });

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    // Stop drawing while the tab is hidden: an off-screen rAF loop burns
    // battery for nobody.
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
    <div className="flow">
      <div className="flow-head">
        <span className="t">{title}</span>
        <span className="spacer" />
        <span className="mono">
          {phase === "IDLE" ? "idle" : phase.replaceAll("_", " ").toLowerCase()}
        </span>
      </div>

      <div className="flow-canvas-wrap" ref={wrapRef}>
        <canvas className="flow-canvas" ref={canvasRef} aria-hidden="true" />
      </div>

      {/* The information itself: real DOM, always present, canvas or not. */}
      <div className="flow-legend">
        {STAGES.map((stage, index) => {
          const isAi = "ai" in stage && stage.ai;
          const here = index === reached && phase !== "CONVERTED";
          return (
            <div
              key={stage.key}
              className={[
                "flow-stage",
                index <= reached ? "reached" : "",
                here ? "here" : "",
                isAi ? "ai" : "",
              ].join(" ")}
            >
              <div className="s-name">
                <stage.icon size={11} strokeWidth={2.2} />
                {stage.label}
              </div>
              <div className="s-value">{values[stage.key] ?? "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
