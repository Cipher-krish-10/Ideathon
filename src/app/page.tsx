import Link from "next/link";

import { ActivityTimeline } from "@/components/dashboard/activity-timeline";
import { Pipeline } from "@/components/dashboard/pipeline";
import type { FlowPhase } from "@/components/dashboard/pipeline";
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

export const dynamic = "force-dynamic";

/**
 * Command Centre.
 *
 * Deliberately not a landing page. There is no tagline, no hero copy and no
 * grid of identically-decorated tiles — a merchant opening this wants the
 * numbers, and marketing furniture inside an instrument is the fastest way to
 * make a product feel generated rather than built.
 *
 * The one distinction the layout enforces: what the merchant's HISTORY says
 * versus what this session actually did.
 */
export default async function CommandCentre() {
  const session = await requireSession();
  const [metrics, interventions, simulation, activity, artifactId] = await Promise.all([
    getDashboardMetrics(session.merchantId),
    listInterventions(session.merchantId),
    getSimulationState(session.merchantId),
    getActivityFeed(session.merchantId),
    getLatestArtifactId(session.merchantId),
  ]);

  // The agent's real position, derived from persisted state.
  const states = new Set(interventions.map((intervention) => intervention.state));
  const phase: FlowPhase =
    metrics.recoveredAmountPaise > 0 ? "CONVERTED"
    : metrics.executedInterventions > 0 ? "EXECUTED"
    : states.has("APPROVED") ? "APPROVED"
    : states.has("PENDING_APPROVAL") ? "AWAITING_APPROVAL"
    : states.has("PROPOSED") || states.has("GUARDRAIL_BLOCKED") ? "REASONED"
    : metrics.openOpportunities > 0 ? "OBSERVED"
    : "IDLE";

  const awaiting = interventions.filter((i) => i.state === "PENDING_APPROVAL");
  const latest = interventions[0];
  const simulatedNow = new Date(simulation.simulatedNow);

  return (
    <>
      <TopBar
        title="Command Centre"
        agentStatus={simulation.status}
        simulationTime={simulatedNow.toLocaleString("en-IN", {
          dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
        })}
      />

      <div className="content">
        {/* --------------------------------------- headline figure, in place */}
        <div className="metric-strip" style={{ marginBottom: "var(--s-5)" }}>
          <div className="lead kpi kpi-historical" style={{ padding: "var(--s-5)" }}>
            <div className="label">
              Recoverable opportunity
              <span className="kpi-tag">Potential</span>
            </div>
            {/* Money at risk, never presented as money earned. */}
            <Counter className="value hero" value={metrics.recoverableAmountPaise}
                     testId="historical-opportunity" />
            <div className="note">
              Potential, from merchant history · {metrics.qualifyingCustomers} qualifying customers
            </div>
          </div>

          <div className="kpi kpi-projected">
            <div className="label">Expected recovery<span className="kpi-tag">Est</span></div>
            <Counter className="value" value={metrics.expectedNetPaise} />
            <div className="note">Estimator projection</div>
          </div>

          <div className="kpi kpi-actual">
            <div className="label">Executed<span className="kpi-tag">Actual</span></div>
            <div className="value" data-testid="executed-actions">{metrics.executedInterventions}</div>
            <div className="note">{metrics.paymentLinksCreated} link(s) at the provider</div>
          </div>

          <div className="kpi kpi-actual">
            <div className="label">Recovered revenue<span className="kpi-tag">Actual</span></div>
            {/* Sourced solely from attribution records. */}
            <Counter className="value" value={metrics.recoveredAmountPaise}
                     testId="recovered-revenue" />
            <div className="note">ACTUAL · confirmed by payment events</div>
          </div>
        </div>

        {/* -------------------------------------------------------- pipeline */}
        <div className="section-label">
          Agent pipeline
          <span className="badge badge-neutral" data-testid="env-demo" style={{ marginLeft: 8 }}>
            Demo environment
          </span>
        </div>
        <Pipeline
          phase={phase}
          values={{
            data: `${metrics.transactionCount.toLocaleString("en-IN")} txns`,
            opportunity: `${metrics.qualifyingCustomers} customers`,
            ai: latest?.reasoningMode === "LLM" ? "LLM ranked" : "Deterministic",
            guardrail: `${RULE_EVALUATORS.length} rules`,
            razorpay: `${metrics.paymentLinksCreated} link(s)`,
            revenue: formatRupees(metrics.recoveredAmountPaise),
          }}
        />

        {/* ---------------------------------------------------------- detail */}
        <div className="grid-2" style={{ marginTop: "var(--s-5)", alignItems: "start" }}>
          <div className="card">
            <div className="card-head">
              <h2>Session activity</h2>
              <span className="spacer" />
              <span className="mono">
                {simulation.status === "ACTIVE" ? "agent active" : "agent idle"}
              </span>
            </div>
            <ActivityTimeline initial={activity} />
          </div>

          <div>
            {awaiting.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h2>Awaiting approval</h2>
                  <span className="spacer" />
                  <span className="badge badge-warn">{awaiting.length}</span>
                </div>
                {awaiting.map((intervention) => (
                  <div key={intervention.id}>
                    <div className="label" style={{ margin: 0 }}>{intervention.playbookName}</div>
                    <div
                      style={{
                        fontSize: 30, fontWeight: 600, letterSpacing: "-.035em",
                        fontVariantNumeric: "tabular-nums", margin: "4px 0 2px",
                      }}
                    >
                      {formatRupees(intervention.expectedNetPaise)}
                    </div>
                    <div className="note muted" style={{ fontSize: 11.5 }}>
                      expected net · {intervention.targetCount} customers ·{" "}
                      {intervention.confidence.toLowerCase()} confidence
                    </div>
                    <Link
                      href={`/interventions/${intervention.id}`}
                      className="btn primary"
                      style={{ marginTop: 16, width: "100%", justifyContent: "center" }}
                    >
                      Review decision packet
                    </Link>
                  </div>
                ))}
              </div>
            )}

            <div className="card">
              <div className="card-head"><h2>Demo controls</h2></div>
              <DemoControls enabled={getEnv().DEMO_MODE} artifactId={artifactId} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
