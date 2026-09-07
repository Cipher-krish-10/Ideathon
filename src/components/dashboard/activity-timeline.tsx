"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  Brain, CheckCircle2, CreditCard, Radar,
  ShieldCheck, Sparkles, ThumbsUp, TrendingUp, Webhook,
} from "lucide-react";

/**
 * Session activity timeline.
 *
 * Every entry is derived from the append-only audit log by the server. This
 * component only chooses an icon and animates the row in — it never adds,
 * reorders, or embellishes an event.
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

  // Polled, not streamed: this is a four-minute demo, and a socket would be
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
        <div className="big">No agent activity in this session yet</div>
        Run the agent to analyse the merchant&apos;s payment history.
      </div>
    );
  }

  return (
    <div className="feed-scroll">
      <ul className="timeline" data-testid="activity-feed">
        <AnimatePresence initial={false}>
          {entries.map((entry, index) => {
            const Icon = ICONS[entry.phase] ?? Radar;
            const toneClass =
              entry.tone === "good" ? "good"
              : entry.tone === "bad" ? "bad"
              : entry.phase === "REASON" ? "ai" : "";
            return (
              <motion.li
                key={entry.seq}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.32, delay: Math.min(index, 8) * 0.025 }}
              >
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
                <span className="tl-time">{time(entry.at)}</span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
