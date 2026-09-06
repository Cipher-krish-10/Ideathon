"use client";

import { useEffect, useState } from "react";

/**
 * Live activity feed.
 *
 * Every line is derived from an append-only audit entry. Nothing here is
 * invented for visual effect — a timeline that can show events which did not
 * happen is worse than no timeline at all.
 */
export interface ActivityEntry {
  seq: number; at: string; phase: string; label: string;
  detail: string | null; actorType: string; simulated: boolean;
  tone: "neutral" | "good" | "bad";
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });
}

export function ActivityFeed({ initial }: { initial: ActivityEntry[] }) {
  const [entries, setEntries] = useState(initial);

  // Poll rather than stream: this is a four-minute demo, and a WebSocket would
  // be infrastructure that earns nothing here.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/simulation");
        if (!response.ok) return;
        const payload = await response.json();
        setEntries(payload.data.activity as ActivityEntry[]);
      } catch {
        // A failed poll is not worth surfacing; the next one will catch up.
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, []);

  if (entries.length === 0) {
    return (
      <p className="empty" data-testid="feed-empty">
        No agent activity in this session yet. Run the agent to begin.
      </p>
    );
  }

  return (
    <ul className="feed" data-testid="activity-feed">
      {entries.map((entry) => (
        <li key={entry.seq} className={entry.tone}>
          <span className="time">{clockTime(entry.at)}</span>
          <span className="phase">{entry.phase}</span>
          <span className="body">
            <span>{entry.label}</span>
            {entry.simulated && <span className="sim-tag">simulated</span>}
            {entry.detail && <div className="detail">{entry.detail}</div>}
          </span>
        </li>
      ))}
    </ul>
  );
}
