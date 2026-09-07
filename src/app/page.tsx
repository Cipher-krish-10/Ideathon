import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { ActivityTimeline } from "@/components/dashboard/activity-timeline";
import { RevenueFlow } from "@/components/dashboard/revenue-flow";
import type { FlowPhase } from "@/components/dashboard/revenue-flow";
import { DemoControls } from "@/components/demo-controls";
import { PageHeader, TopBar } from "@/components/layout/topbar";
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
 * An operations console, not an analytics dashboard. The layout enforces one
 * distinction above all others: what the merchant's HISTORY says is possible,
 * versus what this session has actually done. Those live in different columns,
 * carry different provenance tags, and are never summed.
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

  // The agent's real position, derived from persisted state — never from a
  // timer or a client-side guess.
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
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Overview" }]}
        agentStatus={simulation.status}
        simulationTime={simulatedNow.toLocaleString("en-IN", {
          dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
        })}
      />

      <div className="content">
        <PageHeader
          title="Command centre"
          subtitle="Recoverable revenue detected in this merchant's payment history, and what the agent has done about it."
        />

        {/* ------------------------------------ primary figure + supporting */}
        <div className="metric-strip">
          <div className="metric lead is-potential">
            <div className="m-label">
              Recoverable opportunity
              <span className="m-tag">Potential</span>
            </div>
            {/* Money at risk. Never presented as money earned. */}
            <Counter className="m-value" value={metrics.recoverableAmountPaise}
                     testId="historical-opportunity" />
            <div className="m-note">Potential, from merchant history</div>

            {/* Supporting evidence, inline so each count is never separated
                from the noun it counts. Every figure is server-supplied. */}
            <div className="fact-row">
              <div className="fact">
                <span className="f-value">{metrics.qualifyingCustomers}</span>{" "}
                <span className="f-label">qualifying customers</span>
              </div>
              <div className="fact">
                <span className="f-value">{metrics.failedTransactionCount}</span>{" "}
                <span className="f-label">failed transactions</span>
              </div>
              <div className="fact">
                <span className="f-value">{metrics.transactionCount.toLocaleString("en-IN")}</span>{" "}
                <span className="f-label">transactions scanned</span>
              </div>
            </div>
          </div>

          <div className="metric is-estimate">
            <div className="m-label">Expected recovery<span className="m-tag">Est</span></div>
            <Counter className="m-value" value={metrics.expectedNetPaise} />
            <div className="m-note">Estimator projection on approved actions</div>
          </div>

          <div className="metric is-actual">
            <div className="m-label">Executed actions<span className="m-tag actual">Actual</span></div>
            <div className="m-value" data-testid="executed-actions">{metrics.executedInterventions}</div>
            <div className="m-note">{metrics.paymentLinksCreated} payment link(s) at the provider</div>
          </div>

          <div className="metric is-actual">
            <div className="m-label">Recovered revenue<span className="m-tag actual">Actual</span></div>
            {/* Sourced solely from attribution records written by the webhook
                pipeline. Creating a link does not move this figure. */}
            <Counter className="m-value" value={metrics.recoveredAmountPaise}
                     testId="recovered-revenue" />
            <div className="m-note">ACTUAL · confirmed by payment events</div>
          </div>
        </div>

        {/* ------------------------------------------------------------ flow */}
        <div className="section">
          <h2>Agent pipeline</h2>
          <span className="hint">Where this session actually is</span>
        </div>

        <RevenueFlow
          phase={phase}
          title="Merchant revenue flow"
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
        <div className="grid" style={{ alignItems: "start" }}>
          <div className="col-7">
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
          </div>

          <div className="col-5">
            {awaiting.length > 0 && (
              <div className="panel">
                <div className="panel-head">
                  <h2>Awaiting your approval</h2>
                  <span className="spacer" />
                  <span className="badge badge-warn">{awaiting.length}</span>
                </div>
                {awaiting.map((intervention) => (
                  <div className="panel-body" key={intervention.id}>
                    <div className="m-label">{intervention.playbookName}</div>
                    <div className="m-value" style={{ fontSize: 28 }}>
                      {formatRupees(intervention.expectedNetPaise)}
                    </div>
                    <div className="m-note">
                      Expected net · {intervention.targetCount} customers ·{" "}
                      {intervention.confidence.toLowerCase()} confidence
                    </div>
                    <Link
                      href={`/interventions/${intervention.id}`}
                      className="btn primary"
                      style={{ marginTop: 16, width: "100%" }}
                    >
                      Review decision packet<ArrowRight size={14} />
                    </Link>
                  </div>
                ))}
              </div>
            )}

            <div className="panel">
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
