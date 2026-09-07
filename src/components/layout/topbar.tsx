"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, Play } from "lucide-react";

/**
 * Page header with the primary agent action.
 *
 * The loading copy names the stage the request is actually in — the agent
 * genuinely runs detector, then estimator, then reasoner, then guardrails — so
 * the labels correspond to real work rather than a decorative delay.
 */
const STAGES = [
  "Scanning merchant history…",
  "Evaluating recovery strategies…",
  "Preparing AI recommendation…",
  "Checking merchant guardrails…",
] as const;

export function TopBar({
  title, subtitle, agentStatus, showRunAgent = true, simulationTime,
}: {
  title: string;
  subtitle?: string;
  agentStatus: "IDLE" | "ACTIVE";
  showRunAgent?: boolean;
  /** Demo clock, shown where the page has one. */
  simulationTime?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setResult(null); setError(null); setStage(0);
    // Advances while the single request is in flight. Each label names a stage
    // the server really performs, in the order it performs them.
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
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
        {simulationTime && (
          <div className="sub">
            Simulation time ·{" "}
            <span className="mono" data-testid="simulation-time">{simulationTime}</span>
          </div>
        )}
      </div>

      <div className="right">
        <span className="row" style={{ gap: 6, fontSize: 12, color: "var(--ink-400)" }}>
          <span className={`status-dot ${agentStatus === "ACTIVE" ? "active pulse" : "idle"}`} />
          Agent {agentStatus === "ACTIVE" ? "active" : "idle"}
        </span>
        {showRunAgent && (
          <button className="primary" onClick={run} disabled={busy} data-testid="run-agent">
            <Play size={14} strokeWidth={2.6} />
            {busy ? STAGES[stage] : "Run Agent"}
          </button>
        )}
      </div>

      {(result || error) && (
        <div
          role="status"
          style={{
            position: "absolute", top: "100%", right: "var(--s-6)", marginTop: 8,
            maxWidth: 460, zIndex: 30,
          }}
        >
          <div className={`banner ${error ? "banner-block" : "banner-info"}`} style={{ margin: 0 }}>
            <Activity size={15} />
            <span data-testid={error ? undefined : "run-agent-result"}>{error ?? result}</span>
          </div>
        </div>
      )}
    </header>
  );
}
