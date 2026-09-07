"use client";

/**
 * Recovery funnel.
 *
 * Bar widths are proportional to counts the server supplied. Nothing is
 * recomputed here. A stage with zero rows still gets its label and a visible
 * empty track — a funnel that hides its drop-offs is a funnel that flatters.
 *
 * The width is plain CSS, and the entrance is a CSS `scaleX` transform layered
 * on top. An earlier version animated `width` from 0 to a percentage in
 * Framer Motion: that interpolates between a pixel value and a percentage, so
 * it needs layout mid-flight and silently sticks — two stages with an
 * identical count rendered at 189px and 9px. A bar whose length is the whole
 * message must be correct whether or not any animation runs.
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
    <div className="funnel">
      {stages.map((stage, index) => {
        const pct = (stage.count / max) * 100;
        const isLast = index === stages.length - 1;
        // Below ~14% the count cannot sit legibly inside the bar, so it moves
        // outside rather than being clipped.
        const inside = pct > 14;
        return (
          <div className="funnel-row" key={stage.label}>
            <span className="funnel-label">{stage.label}</span>
            <span className="funnel-track">
              {stage.count > 0 && (
                <span
                  className="funnel-fill"
                  style={{
                    width: `${Math.max(pct, 4)}%`,
                    background: isLast ? "var(--ok-500)" : "var(--blue-500)",
                    animationDelay: `${index * 50}ms`,
                  }}
                >
                  {inside && stage.count}
                </span>
              )}
              {!inside && <span className="funnel-count-out">{stage.count}</span>}
            </span>
            <span className="funnel-meaning">{stage.meaning}</span>
          </div>
        );
      })}

      <div
        className="row"
        style={{ gap: 8, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}
      >
        <span className="badge badge-stop">Blocked by guardrails · {blocked}</span>
        <span className="badge badge-neutral">Rejected by a human · {rejected}</span>
      </div>
    </div>
  );
}
