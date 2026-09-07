"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, ChevronRight, Play } from "lucide-react";

/**
 * Application header.
 *
 * Chrome, not content: a breadcrumb trail, the environment the session is
 * genuinely in, one clock, and the single action that starts work. Page titles
 * live in the content area so every route shares a left edge and the bar keeps
 * a fixed height everywhere.
 *
 * The Run agent loading copy names the stage the request is really in — the
 * server runs detector, then estimator, then reasoner, then guardrails — so
 * the labels track actual work rather than decorating a wait.
 */
const STAGES = [
  "Scanning payment history…",
  "Scoring recovery strategies…",
  "Ranking with the model…",
  "Evaluating guardrails…",
] as const;

export interface Crumb { label: string; href?: string }

/**
 * The simulation clock, formatted once.
 *
 * Every timestamp in the product is on this clock — the header, the activity
 * feed, the audit stream. Showing a simulated clock in the header while
 * stamping the feed from the machine's wall clock made the two disagree, which
 * is simply wrong to read.
 */
export function formatSimulated(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  }).format(date).replace(/ /g, " ");
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  }).format(date);
  return `${day} · ${time}`;
}

export function TopBar({
  crumbs, agentStatus, showRunAgent = true, simulatedNow,
}: {
  crumbs: Crumb[];
  agentStatus: "IDLE" | "ACTIVE";
  showRunAgent?: boolean;
  /** ISO instant from the simulation clock. */
  simulatedNow?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setResult(null); setError(null); setStage(0);
    const ticker = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 1_100);
    try {
      const response = await fetch("/api/agent/run", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "The agent run failed.");
        return;
      }
      const data = payload.data;
      setResult(
        `Found ${data.qualifyingCandidates} qualifying customers. ` +
          `Proposal is ${data.interventionState ?? "unavailable"} (${data.reasoningMode ?? "—"}).`,
      );
      router.refresh();
    } catch {
      setError("Could not reach the agent.");
    } finally {
      clearInterval(ticker);
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 5 }}>
              {index > 0 && <ChevronRight size={12} className="crumb-sep" />}
              {crumb.href && !last ? (
                <a href={crumb.href} className="crumb">{crumb.label}</a>
              ) : (
                <span className={`crumb${last ? " here" : ""}`}>{crumb.label}</span>
              )}
            </span>
          );
        })}
      </nav>

      <div className="right">
        {simulatedNow && (
          <span className="clock" title="The demo's simulation clock. Every timestamp uses it.">
            <span className="clock-kicker">Simulation</span>
            <span className="clock-value mono" data-testid="simulation-time">
              {formatSimulated(simulatedNow)}
            </span>
          </span>
        )}

        <span className="env-chip" data-testid="env-demo">
          <span className={`status-dot ${agentStatus === "ACTIVE" ? "active pulse" : "idle"}`} />
          Demo environment
        </span>

        {showRunAgent && (
          <button className="primary" onClick={run} disabled={busy} data-testid="run-agent">
            <Play size={13} strokeWidth={2.6} />
            {busy ? STAGES[stage] : "Run agent"}
          </button>
        )}
      </div>

      {(result || error) && (
        <div
          role="status"
          style={{
            position: "absolute", top: "100%", right: "var(--gutter)", marginTop: 8,
            maxWidth: 440, zIndex: 40,
          }}
        >
          <div
            className={`banner ${error ? "banner-block" : "banner-info"}`}
            style={{ margin: 0, boxShadow: "var(--sh-2)" }}
          >
            <Activity size={15} />
            <span data-testid={error ? undefined : "run-agent-result"}>{error ?? result}</span>
          </div>
        </div>
      )}
    </header>
  );
}

/**
 * The page's own header, on the content's left edge.
 *
 * Separate from the top bar so chrome keeps a fixed height while page titles
 * stay full size and consistently aligned across routes.
 */
export function PageHeader({
  title, subtitle, actions, bare = false,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  /** Drop the rule when the section below brings its own. */
  bare?: boolean;
}) {
  return (
    <div className={`page-head${bare ? " bare" : ""}`}>
      <div className="titles">
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
