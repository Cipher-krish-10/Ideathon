"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { formatRupees } from "@/lib/format";

/**
 * A figure that counts up when it changes.
 *
 * Takes a format VARIANT rather than a formatter function: a Server Component
 * cannot hand a function across the client boundary, and passing the name keeps
 * the formatting rules in one place.
 *
 * The value is always the one supplied — this animates the presentation of a
 * number the server computed and never derives or rounds it. The final frame is
 * set from the exact value, so what settles on screen is the real figure.
 */
export type CounterFormat = "rupees" | "integer";

const FORMATTERS: Record<CounterFormat, (n: number) => string> = {
  rupees: formatRupees,
  integer: (n) => n.toLocaleString("en-IN"),
};

export function Counter({
  value, format = "rupees", className, testId,
}: {
  value: number;
  format?: CounterFormat;
  className?: string;
  testId?: string;
}) {
  const reduced = useReducedMotion();
  const render = FORMATTERS[format];
  const [display, setDisplay] = useState(() => render(value));
  const previous = useRef(value);

  useEffect(() => {
    if (reduced || previous.current === value) {
      setDisplay(render(value));
      previous.current = value;
      return;
    }
    const controls = animate(previous.current, value, {
      duration: 0.85,
      ease: [0.22, 0.68, 0.32, 1],
      onUpdate: (latest) => setDisplay(render(Math.round(latest))),
      // Settle on the exact value, never an interpolated one.
      onComplete: () => setDisplay(render(value)),
    });
    previous.current = value;
    return () => controls.stop();
  }, [value, render, reduced]);

  return <span className={className} data-testid={testId}>{display}</span>;
}
