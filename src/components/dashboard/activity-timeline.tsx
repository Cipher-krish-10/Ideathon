"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  Brain, CheckCircle2, CreditCard, Radar,
  ShieldCheck, Sparkles, ThumbsUp, TrendingUp, Webhook,
} from "lucide-react";

/**
 * Agent activity.
 *
 * Reads as an infrastructure log, not a decorative feed: a fixed timestamp
 * gutter, one line per event, detail in mono. Every entry is derived by the
 * server from the append-only audit log — this component chooses an icon and
 * nothing else. It never adds, reorders, merges or embellishes an event.
 */
export interface ActivityEntry {
  seq: number; at: string; phase: string; label: string;
  detail: string | null; actorType: string; simulated: boolean;
  tone: "neutral" | "good" | "bad";
}

const ICONS: Record<string, typeof Radar> = {
  OBSERVE: Radar, REASON: Brain, GUARDRAIL: ShieldCheck, APPROVAL: ThumbsUp,
  EXECUTE: CreditCard, PAYMENT: Webhook, ATTRIBUTION: CheckCircle2,
  LEARN: TrendingUp, POLICY: Sparkles,
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });

export function ActivityTimeline({ initial }: { initial: ActivityEntry[] }) {
  const [entries, setEntries] = useState(initial);

  // Polled, not streamed. This is a four-minute demo; a socket would be
  // infrastructure that earns nothing here.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/simulation");
        if (!response.ok) return;
        const payload = await response.json();
        setEntries(payload.data.activity as ActivityEntry[]);
      } catch {
        // A dropped poll is not worth surfacing; the next one catches up.
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, []);

  if (entries.length === 0) {
    return (
      <div className="empty" data-testid="feed-empty">
        <div className="big">No agent activity in this session</div>
        Run the agent to analyse this merchant&apos;s payment history.
      </div>
    );
  }

  return (
    <div className="feed-scroll">
      <ul className="timeline" data-testid="activity-feed">
        {/* initial={false} so a reload paints the log instantly. Only genuinely
            NEW events animate in — the motion means "this just happened". */}
        <AnimatePresence initial={false}>
          {entries.map((entry) => {
            const Icon = ICONS[entry.phase] ?? Radar;
            const toneClass =
              entry.tone === "good" ? "good"
              : entry.tone === "bad" ? "bad"
              : entry.phase === "REASON" ? "ai" : "";
            return (
              <motion.li
                key={entry.seq}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22 }}
              >
                <span className="tl-time">{time(entry.at)}</span>
                <span className={`tl-icon ${toneClass}`}><Icon strokeWidth={2.1} /></span>
                <span className="tl-body">
                  <span className="tl-label">
                    {entry.label}
                    {entry.simulated && (
                      <span className="badge badge-warn" style={{ marginLeft: 7 }}>simulated</span>
                    )}
                  </span>
                  {entry.detail && <span className="tl-detail">{entry.detail}</span>}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
