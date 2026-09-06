import { ActivityFeed } from "@/components/activity-feed";
import { DemoControls } from "@/components/demo-controls";
import { RunAgentButton } from "@/components/run-agent-button";
import { formatRupees } from "@/lib/format";
import { getEnv } from "@/lib/env";
import { requireSession } from "@/server/auth/session";
import {
  getDashboardMetrics,
  getLatestArtifactId,
  listInterventions,
} from "@/server/services/read.service";
import { getActivityFeed, getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

/**
 * Command Centre.
 *
 * The organising idea of this page is a hard separation between what the
 * merchant's HISTORY says and what happened in THIS demo session. Historical
 * figures are potential; session figures are what the agent actually did; and
 * only an attributed payment is called recovered revenue.
 */
export default async function CommandCentre() {
  const session = await requireSession();
  const [metrics, pending, simulation, activity, latestArtifact] = await Promise.all([
    getDashboardMetrics(session.merchantId),
    listInterventions(session.merchantId, "PENDING_APPROVAL"),
    getSimulationState(session.merchantId),
    getActivityFeed(session.merchantId),
    getLatestArtifactId(session.merchantId),
  ]);

  const simulatedNow = new Date(simulation.simulatedNow);
  const format = (date: Date) =>
    date.toLocaleString("en-IN", {
      dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata",
    });

  return (
    <main className="page">
      <div className="agent-header">
        <div className="title">
          <h1>RevenuePilot</h1>
          <div className="role">Merchant Growth Agent · Nimbus Commerce</div>
        </div>

        <div className="env">
          {/* Said plainly: the history is synthetic, the provider is test mode. */}
          <span className="env-tag" data-testid="env-demo">Demo environment</span>
          <span className="env-tag test">Razorpay Test Mode</span>
        </div>

        <div className="clock">
          <div className="label">Simulation time</div>
          <div className="value" data-testid="simulation-time">{format(simulatedNow)}</div>
          <div className="label" style={{ marginTop: 8 }}>Agent status</div>
          <div className="value" data-testid="agent-status">
            <span className={`status-dot ${simulation.status === "ACTIVE" ? "active" : "idle"}`} />
            {simulation.status === "ACTIVE" ? "Active" : "Idle"}
          </div>
        </div>
      </div>

      {/* ---------------- Historical baseline ---------------- */}
      <div className="section-label">Historical merchant baseline · synthetic payment history</div>
      <div className="grid grid-4">
        <div className="metric historical">
          <div className="label">Detected opportunity</div>
          <div className="value" data-testid="historical-opportunity">
            {formatRupees(metrics.recoverableAmountPaise)}
          </div>
          {/* Never called revenue: this is what was found at risk, not earned. */}
          <div className="note">Potential, from merchant history</div>
        </div>
        <div className="metric historical">
          <div className="label">Qualifying customers</div>
          <div className="value">{metrics.qualifyingCustomers}</div>
          <div className="note">Detected from payment history</div>
        </div>
        <div className="metric historical">
          <div className="label">Open opportunities</div>
          <div className="value">{metrics.openOpportunities}</div>
          <div className="note">Awaiting an agent decision</div>
        </div>
        <div className="metric historical">
          <div className="label">Baseline ends</div>
          <div className="value" style={{ fontSize: 15, fontFamily: "var(--mono)" }}>
            {new Date(simulation.baselineAt).toLocaleDateString("en-IN", {
              dateStyle: "medium", timeZone: "Asia/Kolkata",
            })}
          </div>
          <div className="note">History stops here; the session starts</div>
        </div>
      </div>

      {/* ---------------- This session ---------------- */}
      <div className="section-label">This demo session · generated now, in Razorpay Test Mode</div>
      <div className="grid grid-4">
        <div className="metric projected">
          <div className="label">Expected net</div>
          <div className="value">{formatRupees(metrics.expectedNetPaise)}</div>
          <div className="note">ESTIMATE · estimator projection</div>
        </div>
        <div className="metric actual">
          <div className="label">Executed actions</div>
          <div className="value" data-testid="executed-actions">{metrics.executedInterventions}</div>
          <div className="note">ACTUAL · links created at the provider</div>
        </div>
        <div className="metric actual">
          <div className="label">Awaiting payment</div>
          <div className="value">{formatRupees(metrics.paymentLinkValuePaise)}</div>
          <div className="note">{metrics.paymentLinksCreated} link(s) · not yet collected</div>
        </div>
        <div className="metric actual">
          <div className="label">Actual recovered revenue</div>
          <div className="value" data-testid="recovered-revenue">
            {formatRupees(metrics.recoveredAmountPaise)}
          </div>
          {/* Sourced solely from attribution records. */}
          <div className="note">ACTUAL · confirmed by payment events</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2>Agent</h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
            Runs detector → estimator → reasoner → guardrails over the merchant&apos;s
            history, then stops for a human. No money action can follow without approval.
          </p>
          <RunAgentButton />
        </div>

        <div className="card">
          <h2>Demo controls</h2>
          <DemoControls enabled={getEnv().DEMO_MODE} artifactId={latestArtifact} />
        </div>
      </div>

      <div className="card">
        <h2>
          Activity
          <span className="pill pill-muted">this session</span>
        </h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Every line below is derived from the append-only audit log — an audited
          operation produced it. Nothing here is generated for effect.
        </p>
        <ActivityFeed initial={activity} />
      </div>

      {pending.length > 0 && (
        <div className="card">
          <h2>Awaiting your approval</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Playbook</th><th>Customers</th>
                  <th className="num">Expected net</th><th>Confidence</th><th />
                </tr>
              </thead>
              <tbody>
                {pending.map((intervention) => (
                  <tr key={intervention.id}>
                    <td>{intervention.playbookName}</td>
                    <td>{intervention.targetCount}</td>
                    <td className="num">{formatRupees(intervention.expectedNetPaise)}</td>
                    <td><span className="pill pill-muted">{intervention.confidence}</span></td>
                    <td><a href={`/interventions/${intervention.id}`}>Open decision packet →</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
