import { notFound } from "next/navigation";

import { TopBar } from "@/components/layout/topbar";
import { formatPercent, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getOpportunityDetail } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const [opportunity, simulation] = await Promise.all([
    getOpportunityDetail(session.merchantId, id),
    getSimulationState(session.merchantId),
  ]);
  if (!opportunity) notFound();

  return (
    <>
      <TopBar
        title="Opportunity evidence"
        subtitle={`${opportunity.affectedCustomerCount} customers · ${formatRupees(opportunity.recoverableAmountPaise)} · ${opportunity.detectorVersion}`}
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Why these qualified</h2></div>
          <table>
            <thead><tr><th>Failure reason</th><th className="num">Count</th></tr></thead>
            <tbody>
              {Object.entries(opportunity.failureReasonBreakdown).map(([reason, count]) => (
                <tr key={reason}><td>{reason.toLowerCase().replaceAll("_", " ")}</td><td className="num">{count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head"><h2>Why the rest did not</h2></div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            The agent discriminated rather than counting failed payments.
          </p>
          <table>
            <tbody>
              {Object.entries(opportunity.exclusionCounts)
                .filter(([, count]) => count > 0)
                .map(([reason, count]) => (
                  <tr key={reason}>
                    <td>{reason.toLowerCase().replaceAll("_", " ")}</td>
                    <td className="num">{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Deterministic strategies</h2></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Playbook</th><th className="num">Recovery</th><th className="num">Gross</th>
                <th className="num">Cost</th><th className="num">Expected net</th><th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {opportunity.estimates.map((estimate) => (
                <tr key={estimate.estimateId}>
                  <td>{estimate.playbookName}</td>
                  <td className="num">{formatPercent(estimate.pRecoverAvgBps)}</td>
                  <td className="num">{formatRupees(estimate.expectedGrossPaise)}</td>
                  <td className="num">{formatRupees(estimate.costPaise)}</td>
                  <td className="num"><strong>{formatRupees(estimate.expectedNetPaise)}</strong></td>
                  <td><span className="badge badge-neutral">{estimate.confidence}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Targets ({opportunity.targets.length})</h2></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Dataset references and tier only. No contact details are shown, because nothing
          on this page needs one.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th><th>Tier</th><th>Transaction</th>
                <th className="num">Amount</th><th>Failure reason</th><th className="num">Attempt</th>
              </tr>
            </thead>
            <tbody>
              {opportunity.targets.map((target) => (
                <tr key={target.transactionRef}>
                  <td className="mono">{target.customerRef}</td>
                  <td><span className="badge badge-neutral">{target.customerTier}</span></td>
                  <td className="mono">{target.transactionRef}</td>
                  <td className="num">{formatRupees(target.amountPaise)}</td>
                  <td>{String(target.failureReason ?? "").toLowerCase().replaceAll("_", " ")}</td>
                  <td className="num">{target.failedAttemptNo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {opportunity.interventions.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Proposals</h2></div>
          <table>
            <tbody>
              {opportunity.interventions.map((intervention) => (
                <tr key={intervention.id}>
                  <td><span className="badge badge-neutral">{intervention.state}</span></td>
                  <td className="mono">{intervention.reasoningMode}</td>
                  <td><a href={`/interventions/${intervention.id}`}>Open decision packet →</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </>
  );
}
