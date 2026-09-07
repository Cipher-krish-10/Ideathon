import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleDashed, ShieldAlert } from "lucide-react";

import { ActivityTimeline } from "@/components/dashboard/activity-timeline";
import { RevenueFlow } from "@/components/dashboard/revenue-flow";
import type { FlowPhase } from "@/components/dashboard/revenue-flow";
import { DemoControls } from "@/components/demo-controls";
import { TopBar } from "@/components/layout/topbar";
import { Counter } from "@/components/ui/counter";
import { RULE_EVALUATORS } from "@/core/guardrails/rules";
import { formatRupees } from "@/lib/format";
import { getEnv } from "@/lib/env";
import { requireSession } from "@/server/auth/session";
import {
  getDashboardMetrics, getLatestArtifactId, listInterventions,
} from "@/server/services/read.service";
import { getActivityFeed, getSimulationState } from "@/server/services/simulation";
import { getSessionProjection } from "@/server/services/simulation/session-time";

export const dynamic = "force-dynamic";

/** Greeting keyed to the simulation clock, so it agrees with the header. */
function greeting(simulatedNow: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-IN", {
      hour: "numeric", hour12: false, timeZone: "Asia/Kolkata",
    }).format(simulatedNow),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Command centre.
 *
 * RevenuePilot is an action console, not an analytics dashboard. A merchant
 * opens this asking one question — "what should I approve right now?" — so the
 * page answers in that order: the opportunity, then the agent's position, then
 * the recommendation, then the controls.
 *
 * Two distinctions the layout enforces, because getting either wrong would
 * misrepresent what happened:
 *
 *   POTENTIAL vs ACTUAL — what the merchant's history says is recoverable,
 *   versus money a payment event has confirmed. Never summed, never adjacent
 *   without a provenance tag.
 *
 *   CURRENT vs PREVIOUSLY EXECUTED — a blocked proposal and a successful
 *   execution are different operations. Styling them alike is how a console
 *   tells its user something false.
 */
export default async function CommandCentre() {
  const session = await requireSession();
  const [metrics, interventions, simulation, activity, artifactId, clock] = await Promise.all([
    getDashboardMetrics(session.merchantId),
    listInterventions(session.merchantId),
    getSimulationState(session.merchantId),
    getActivityFeed(session.merchantId),
    getLatestArtifactId(session.merchantId),
    getSessionProjection(session.merchantId),
  ]);

  // The CURRENT intervention is the most recent proposal — the thing the
  // merchant is being asked about. Everything else is history.
  const current = interventions[0] ?? null;
  const EXECUTED_STATES = ["EXECUTED", "OBSERVING", "CONVERTED", "NOT_CONVERTED", "LEARNED"];
  const previouslyExecuted = interventions
    .slice(1)
    .filter((intervention) => EXECUTED_STATES.includes(intervention.state));

  // The agent's position, derived from the CURRENT intervention rather than
  // from a maximum over all of them. Taking the max is what previously let the
  // page claim "executed" while the live proposal was actually blocked.
  const phase: FlowPhase =
    current === null ? (metrics.openOpportunities > 0 ? "OBSERVED" : "IDLE")
    : current.state === "LEARNED" ? "LEARNED"
    : current.state === "CONVERTED" ? "CONVERTED"
    : ["EXECUTED", "OBSERVING", "NOT_CONVERTED"].includes(current.state) ? "EXECUTED"
    : current.state === "APPROVED" ? "APPROVED"
    : current.state === "PENDING_APPROVAL" ? "AWAITING_APPROVAL"
    : current.state === "GUARDRAIL_BLOCKED" ? "BLOCKED"
    : ["PROPOSED", "REJECTED", "EXPIRED"].includes(current.state) ? "REASONED"
    : "OBSERVED";

  const awaitingDecision = current?.state === "PENDING_APPROVAL";
  const blocked = current?.state === "GUARDRAIL_BLOCKED";
  // Same clock as the header, so the greeting cannot disagree with it.
  const simulatedNow = clock.now();

  return (
    <>
      <TopBar
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Overview" }]}
        agentStatus={simulation.status}
        simulatedNow={clock.now().toISOString()}
      />

      <div className="content">
        <div className="greet">
          <h1>{greeting(simulatedNow)}, Nimbus Commerce</h1>
          <p>
            RevenuePilot found a recoverable growth opportunity in your payment history.
          </p>
        </div>

        {/* ===================================================== the ask === */}
        <div className="hero">
          <div className="hero-main">
            <div className="hero-label">
              Recoverable opportunity
              <span className="m-tag">Potential</span>
            </div>
            {/* Money at risk. Never presented as money earned. */}
            <Counter className="hero-value" value={metrics.recoverableAmountPaise}
                     testId="historical-opportunity" />
            <div className="hero-facts">
              <span><b>{metrics.qualifyingCustomers}</b> customers</span>
              {/* The gap between these two IS the product's claim: the detector
                  discriminated instead of counting every failure. */}
              <span><b>{metrics.qualifyingTransactionCount}</b> recoverable</span>
              <span>of <b>{metrics.failedTransactionCount}</b> failed transactions</span>
            </div>
          </div>

          <div className="hero-actions">
            {current ? (
              <Link className="btn primary" href={`/interventions/${current.id}`}>
                {awaitingDecision ? "Review and approve" : "Review opportunity"}
                <ArrowRight size={14} />
              </Link>
            ) : (
              <Link className="btn" href="/opportunities">
                Review opportunity<ArrowRight size={14} />
              </Link>
            )}
          </div>
        </div>

        {/* Supporting figures. On the page, not in tiles. */}
        <div className="strip">
          <div className="s-item">
            <div className="si-label">Expected recovery<span className="m-tag">Est</span></div>
            <div className="si-value"><Counter value={metrics.expectedNetPaise} /></div>
            <div className="si-note">Estimator projection</div>
          </div>
          <div className="s-item">
            <div className="si-label">Executed<span className="m-tag actual">Actual</span></div>
            <div className="si-value" data-testid="executed-actions">
              {metrics.executedInterventions}
            </div>
            <div className="si-note">{metrics.paymentLinksCreated} payment link(s)</div>
          </div>
          <div className="s-item">
            <div className="si-label">Recovered<span className="m-tag actual">Actual</span></div>
            <div className="si-value">
              {/* Sourced solely from attribution records written by the webhook
                  pipeline. Creating a link does not move this figure. */}
              <Counter value={metrics.recoveredAmountPaise} testId="recovered-revenue" />
            </div>
            <div className="si-note">ACTUAL · confirmed by payment events</div>
          </div>
        </div>

        {/* ================================================== the console === */}
        <div className="console">
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="panel-head">
              <h2>Agent pipeline</h2>
              <span className="spacer" />
              <span className="mono">
                {phase === "IDLE" ? "idle" : phase.replaceAll("_", " ").toLowerCase()}
              </span>
            </div>

            <RevenueFlow
              phase={phase}
              values={{
                data: `${metrics.transactionCount.toLocaleString("en-IN")} txns`,
                opportunity: `${metrics.qualifyingCustomers} customers`,
                ai: current?.reasoningMode === "LLM" ? "LLM ranked" : "Deterministic",
                guardrail: `${RULE_EVALUATORS.length} rules`,
                razorpay: `${metrics.paymentLinksCreated} link(s)`,
                revenue: formatRupees(metrics.recoveredAmountPaise),
              }}
            />

            {/* Current versus history, never confusable. */}
            <div className="state-split">
              <div className="state-block">
                <div className="state-kicker">Current intervention</div>
                {current ? (
                  <>
                    <div className="state-headline">
                      <span className={
                        blocked ? "status-dot" : awaitingDecision ? "status-dot" : "status-dot active"
                      } style={blocked
                        ? { background: "var(--stop-500)" }
                        : awaitingDecision ? { background: "var(--warn-500)" } : undefined} />
                      {current.state.replaceAll("_", " ")}
                    </div>
                    <div className="state-detail">
                      {current.playbookName} · {current.targetCount} customers ·{" "}
                      {formatRupees(current.expectedNetPaise)} expected net
                    </div>
                  </>
                ) : (
                  <>
                    <div className="state-headline">
                      <CircleDashed size={14} color="var(--ink-300)" />No proposal yet
                    </div>
                    <div className="state-detail">Run the agent to produce one.</div>
                  </>
                )}
              </div>

              <div className="state-block past">
                <div className="state-kicker">Previously executed</div>
                <div className="state-headline">
                  {previouslyExecuted.length > 0
                    ? <CheckCircle2 size={14} color="var(--ok-500)" />
                    : <CircleDashed size={14} color="var(--ink-300)" />}
                  {previouslyExecuted.length} intervention
                  {previouslyExecuted.length === 1 ? "" : "s"}
                </div>
                <div className="state-detail">
                  {metrics.paymentLinksCreated} payment link(s) created ·{" "}
                  {formatRupees(metrics.recoveredAmountPaise)} recovered
                </div>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------- activity --- */}
          <div>
            {awaitingDecision && current && (
              <div className="panel">
                <div className="panel-head">
                  <h2>Awaiting your approval</h2>
                  <span className="spacer" />
                  <span className="badge badge-warn">1</span>
                </div>
                <div className="panel-body">
                  <div className="si-label">{current.playbookName}</div>
                  <div className="si-value" style={{ fontSize: 26 }}>
                    {formatRupees(current.expectedNetPaise)}
                  </div>
                  <div className="si-note">
                    Expected net · {current.targetCount} customers ·{" "}
                    {current.confidence.toLowerCase()} confidence
                  </div>
                  <Link href={`/interventions/${current.id}`} className="btn primary"
                        style={{ marginTop: 14, width: "100%" }}>
                    Review decision packet<ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            )}

            {blocked && current && (
              <div className="panel">
                <div className="panel-head">
                  <h2>Action blocked</h2>
                  <span className="spacer" />
                  <span className="badge badge-stop">Policy</span>
                </div>
                <div className="panel-body">
                  <div className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                    <ShieldAlert size={15} color="var(--stop-500)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 13, color: "var(--ink-700)" }}>
                      A policy control refused this action. Nothing was sent and no money moved.
                    </span>
                  </div>
                  <Link href={`/interventions/${current.id}`} className="btn"
                        style={{ marginTop: 14, width: "100%" }}>
                    See which control<ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <h2>Agent activity</h2>
                <span className="spacer" />
                <span className="row" style={{ gap: 6 }}>
                  <span className={`status-dot ${simulation.status === "ACTIVE" ? "active" : "idle"}`} />
                  <span className="mono">
                    {simulation.status === "ACTIVE" ? "running" : "idle"}
                  </span>
                </span>
              </div>
              <ActivityTimeline initial={activity} />
            </div>

            <div className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-head"><h2>Demo controls</h2></div>
              <div className="panel-body">
                <DemoControls enabled={getEnv().DEMO_MODE} artifactId={artifactId} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
