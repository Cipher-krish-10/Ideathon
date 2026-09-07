"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, ChevronRight, Clock, Play } from "lucide-react";

/**
 * Application header.
 *
 * Chrome, not content: a breadcrumb trail, the environment the session is
 * really in, and the one action that starts work. The page's title lives in
 * the content area (see PageHeader) so every route shares a left edge and the
 * header stays the same height everywhere.
 *
 * The Run Agent loading copy names the stage the request is genuinely in — the
 * server really runs detector, then estimator, then reasoner, then guardrails —
 * so the labels track real work rather than decorating a wait.
 */
const STAGES = [
  "Scanning payment history…",
  "Scoring recovery strategies…",
  "Ranking with the model…",
  "Evaluating guardrails…",
] as const;

export interface Crumb { label: string; href?: string }

export function TopBar({
  crumbs, agentStatus, showRunAgent = true, simulationTime, environment = "Demo",
}: {
  crumbs: Crumb[];
  agentStatus: "IDLE" | "ACTIVE";
  showRunAgent?: boolean;
  /** Demo clock, shown where the route has one. */
  simulationTime?: string;
  environment?: string;
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
            <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 6 }}>
              {index > 0 && <ChevronRight size={13} className="crumb-sep" />}
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
        {simulationTime && (
          <span className="env-chip" title="Simulated clock for the demo session">
            <Clock size={12} strokeWidth={2} />
            <span className="mono" data-testid="simulation-time">{simulationTime}</span>
          </span>
        )}

        <span className="env-chip" data-testid="env-demo">
          <span className={`status-dot ${agentStatus === "ACTIVE" ? "active pulse" : "idle"}`} />
          {environment} environment
        </span>

        {showRunAgent && (
          <>
            <span className="topbar-divider" />
            <button className="primary" onClick={run} disabled={busy} data-testid="run-agent">
              <Play size={13} strokeWidth={2.6} />
              {busy ? STAGES[stage] : "Run agent"}
            </button>
          </>
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
 * Separating this from the top bar is what keeps the chrome a fixed height
 * while page titles stay full-size and consistently aligned across routes.
 */
export function PageHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="titles">
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
