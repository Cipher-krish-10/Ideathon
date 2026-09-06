import { RunAgentButton } from "@/components/run-agent-button";
import { formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getDashboardMetrics, listInterventions } from "@/server/services/read.service";

export const dynamic = "force-dynamic";

export default async function CommandCentre() {
  const session = await requireSession();
  const [metrics, pending] = await Promise.all([
    getDashboardMetrics(session.merchantId),
    listInterventions(session.merchantId, "PENDING_APPROVAL"),
  ]);

  return (
    <main className="page">
      <h1>Command Centre</h1>
      <p className="subtitle">
        Failed-payment recovery for Nimbus Commerce. Every figure below is computed
        deterministically and traces to a database row.
      </p>

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="metric">
          <div className="label">Recoverable revenue</div>
          <div className="value">{formatRupees(metrics.recoverableAmountPaise)}</div>
          {/* Never presented as money already earned. */}
          <div className="note">Potential — not yet recovered</div>
        </div>
        <div className="metric">
          <div className="label">Qualifying customers</div>
          <div className="value">{metrics.qualifyingCustomers}</div>
          <div className="note">Across {metrics.openOpportunities} open opportunity(ies)</div>
        </div>
        <div className="metric">
          <div className="label">Pending approvals</div>
          <div className="value">{metrics.pendingApprovals}</div>
          <div className="note">Awaiting a human decision</div>
        </div>
        <div className="metric">
          <div className="label">Recovered revenue</div>
          <div className="value">{formatRupees(metrics.recoveredAmountPaise)}</div>
          <div className="note">Nothing has executed yet</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Agent</h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
            Runs detector → estimator → reasoner → guardrails, then stops for a human.
            No money action can follow without approval.
          </p>
          <RunAgentButton />
        </div>

        <div className="card">
          <h2>Pipeline</h2>
          <table>
            <tbody>
              <tr><td>Approved interventions</td><td className="num">{metrics.approvedInterventions}</td></tr>
              <tr><td>Blocked by guardrails</td><td className="num">{metrics.blockedInterventions}</td></tr>
              <tr><td>Rejected</td><td className="num">{metrics.rejectedInterventions}</td></tr>
              <tr>
                <td>Audit chain</td>
                <td className="num">
                  {metrics.auditVerified ? `verified · ${metrics.auditEntryCount}` : "BROKEN"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Awaiting approval</h2>
        {pending.length === 0 ? (
          <p className="empty">Nothing is waiting on a decision. Run the agent to create a proposal.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Playbook</th><th>Customers</th>
                  <th className="num">Expected net</th><th>Confidence</th><th>Reasoning</th><th />
                </tr>
              </thead>
              <tbody>
                {pending.map((intervention) => (
                  <tr key={intervention.id}>
                    <td>{intervention.playbookName}</td>
                    <td>{intervention.targetCount}</td>
                    <td className="num">{formatRupees(intervention.expectedNetPaise)}</td>
                    <td><span className="pill pill-muted">{intervention.confidence}</span></td>
                    <td className="mono">{intervention.reasoningMode}</td>
                    <td><a href={`/interventions/${intervention.id}`}>Open decision packet →</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
