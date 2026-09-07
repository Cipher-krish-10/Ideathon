import Link from "next/link";
import { Activity, Sparkles } from "lucide-react";

import { ActivityTimeline } from "@/components/dashboard/activity-timeline";
import { OpportunityHero } from "@/components/dashboard/opportunity-hero";
import { RevenueFlow } from "@/components/dashboard/revenue-flow";
import type { FlowPhase } from "@/components/dashboard/revenue-flow";
import { DemoControls } from "@/components/demo-controls";
import { TopBar } from "@/components/layout/topbar";
import { Counter } from "@/components/ui/counter";
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
 * Organised around one distinction: what the merchant's HISTORY says versus
 * what this session actually did. Historical figures are potential; session
 * figures are facts; and only an attributed payment is called revenue. The
 * layout never places the two in the same row.
 */
export default async function CommandCentre() {
  const session = await requireSession();
  const [metrics, pending, simulation, activity, artifactId] = await Promise.all([
    getDashboardMetrics(session.merchantId),
    listInterventions(session.merchantId),
    getSimulationState(session.merchantId),
    getActivityFeed(session.merchantId),
    getLatestArtifactId(session.merchantId),
  ]);

  // The agent's real position in the pipeline, derived from persisted state.
  const states = new Set(pending.map((intervention) => intervention.state));
  const phase: FlowPhase =
    metrics.recoveredAmountPaise > 0 ? "CONVERTED"
    : metrics.executedInterventions > 0 ? "EXECUTED"
    : states.has("APPROVED") ? "APPROVED"
    : states.has("PENDING_APPROVAL") ? "AWAITING_APPROVAL"
    : states.has("PROPOSED") || states.has("GUARDRAIL_BLOCKED") ? "REASONED"
    : metrics.openOpportunities > 0 ? "OBSERVED"
    : "IDLE";

  const awaiting = pending.filter((i) => i.state === "PENDING_APPROVAL");
  const latest = pending[0];
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
        {/* ---------------------------------------------------------- hero */}
        <div style={{ marginBottom: "var(--s-5)" }}>
          <div className="row" style={{ gap: 10, marginBottom: 10 }}>
            <span className="badge badge-ai"><Sparkles />Autonomous merchant growth agent</span>
            <span className="badge badge-neutral" data-testid="env-demo">Demo environment</span>
          </div>
          <h2 style={{ fontSize: 30, margin: "0 0 6px", letterSpacing: "-.032em", fontWeight: 650 }}>
            Find lost revenue. Choose the best intervention. Act safely.
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: 14.5, maxWidth: 640 }}>
            RevenuePilot reads the merchant&apos;s payment history, scores every recovery
            strategy deterministically, and asks a human before anything moves.
          </p>
        </div>

        <RevenueFlow
          phase={phase}
          captions={{
            data: "1,200 transactions",
            opportunity: `${metrics.qualifyingCustomers} customers`,
            ai: latest?.reasoningMode === "LLM" ? "model reasoning" : "deterministic",
            guardrail: "10 rules",
            razorpay: `${metrics.paymentLinksCreated} link(s)`,
            revenue: formatRupees(metrics.recoveredAmountPaise),
          }}
        />

        {/* ------------------------------------------ historical baseline */}
        <div className="section-label">Historical merchant baseline · synthetic payment history</div>
        <div className="kpi-grid">
          <div className="kpi kpi-historical" style={{ gridColumn: "span 2" }}>
            <span className="kpi-tag">Potential</span>
            <div className="label">Recoverable opportunity</div>
            {/* Never called revenue: money at risk, not money earned. */}
            <Counter
              className="value hero"
              value={metrics.recoverableAmountPaise}
                            testId="historical-opportunity"
            />
            <div className="note">Potential, from merchant history</div>
          </div>
          <div className="kpi kpi-historical">
            <div className="label">Qualifying customers</div>
            <div className="value">{metrics.qualifyingCustomers}</div>
            <div className="note">Detected from payment history</div>
          </div>
          <div className="kpi kpi-historical">
            <div className="label">Baseline ends</div>
            <div className="value" style={{ fontSize: 19 }}>
              {new Date(simulation.baselineAt).toLocaleDateString("en-IN", {
                dateStyle: "medium", timeZone: "Asia/Kolkata",
              })}
            </div>
            <div className="note">History stops; the session begins</div>
          </div>
        </div>

        {/* ------------------------------------------------ this session */}
        <div className="section-label">This demo session · Razorpay Test Mode</div>
        <div className="kpi-grid">
          <div className="kpi kpi-projected">
            <span className="kpi-tag">Estimate</span>
            <div className="label">Expected recovery</div>
            <Counter className="value" value={metrics.expectedNetPaise} />
            <div className="note">Estimator projection</div>
          </div>
          <div className="kpi kpi-actual">
            <span className="kpi-tag">Actual</span>
            <div className="label">Executed actions</div>
            <div className="value" data-testid="executed-actions">{metrics.executedInterventions}</div>
            <div className="note">Links created at the provider</div>
          </div>
          <div className="kpi kpi-actual">
            <span className="kpi-tag">Actual</span>
            <div className="label">Awaiting payment</div>
            <Counter className="value" value={metrics.paymentLinkValuePaise} />
            <div className="note">{metrics.paymentLinksCreated} link(s) · not yet collected</div>
          </div>
          <div className="kpi kpi-actual">
            <span className="kpi-tag">Actual</span>
            <div className="label">Recovered revenue</div>
            {/* Sourced solely from attribution records. */}
            <Counter
              className="value"
              value={metrics.recoveredAmountPaise}
                            testId="recovered-revenue"
            />
            <div className="note">ACTUAL · confirmed by payment events</div>
          </div>
        </div>

        {/* -------------------------------------------------- opportunity */}
        {metrics.qualifyingCustomers > 0 && (
          <div className="card" style={{ marginTop: "var(--s-5)" }}>
            <div className="card-head">
              <h2>Revenue opportunity detected</h2>
              <span className="badge badge-blue">Detected from merchant history</span>
            </div>
            <OpportunityHero
              failedTransactions={66}
              qualifying={metrics.qualifyingCustomers}
              customers={metrics.qualifyingCustomers}
              valueLabel={formatRupees(metrics.recoverableAmountPaise)}
            />
          </div>
        )}

        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Agent activity</h2>
              <span className="spacer" />
              <span className="badge badge-neutral">
                <span className={`status-dot ${simulation.status === "ACTIVE" ? "active pulse" : "idle"}`} />
                {simulation.status === "ACTIVE" ? "Active" : "Idle"}
              </span>
            </div>
            <p className="card-note">
              Derived from the append-only audit log. If a line appears here, an audited
              operation produced it.
            </p>
            <ActivityTimeline initial={activity} />
          </div>

          <div>
            {awaiting.length > 0 && (
              <div className="card">
                <div className="card-head">
                  <h2>Awaiting your approval</h2>
                  <span className="badge badge-warn">{awaiting.length}</span>
                </div>
                {awaiting.map((intervention) => (
                  <div key={intervention.id} className="strategy chosen" style={{ marginBottom: 10 }}>
                    <div className="s-name">{intervention.playbookName}</div>
                    <div className="s-net">{formatRupees(intervention.expectedNetPaise)}</div>
                    <div className="s-line"><span>Expected net</span><span>{intervention.confidence}</span></div>
                    <div className="s-line"><span>Customers</span><span>{intervention.targetCount}</span></div>
                    <Link
                      href={`/interventions/${intervention.id}`}
                      className="btn primary"
                      style={{ marginTop: 14, width: "100%", justifyContent: "center" }}
                    >
                      Open decision packet
                    </Link>
                  </div>
                ))}
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h2>Demo controls</h2>
                <span className="badge badge-neutral"><Activity />Simulation</span>
              </div>
              <DemoControls enabled={getEnv().DEMO_MODE} artifactId={artifactId} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
