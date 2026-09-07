import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { PageHeader, TopBar } from "@/components/layout/topbar";
import { formatPercent, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getOpportunityDetail } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";
import { getSessionProjection } from "@/server/services/simulation/session-time";

export const dynamic = "force-dynamic";

/**
 * Opportunity evidence.
 *
 * The page that answers "why do you believe this?". Both halves of the
 * detector's judgement are shown side by side — who qualified and who did not
 * — because a detector that only reports its positives is indistinguishable
 * from one that counts every failed payment.
 */
export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const [opportunity, simulation, clock] = await Promise.all([
    getOpportunityDetail(session.merchantId, id),
    getSimulationState(session.merchantId),
    getSessionProjection(session.merchantId),
  ]);
  if (!opportunity) notFound();

  const excluded = Object.entries(opportunity.exclusionCounts).filter(([, count]) => count > 0);
  const excludedTotal = excluded.reduce((sum, [, count]) => sum + count, 0);

  return (
    <>
      <TopBar
        crumbs={[
          { label: "Nimbus Commerce", href: "/" },
          { label: "Opportunities", href: "/opportunities" },
          { label: "Evidence" },
        ]}
        agentStatus={simulation.status}
        simulatedNow={clock.now().toISOString()}
        showRunAgent={false}
      />
      <div className="content">
        <Link href="/opportunities" className="row-link" style={{ marginBottom: 12 }}>
          <ArrowLeft size={12} />Back to opportunities
        </Link>

        <PageHeader
          title="Opportunity evidence"
          subtitle="Every record behind the headline figure, and every record the detector deliberately excluded."
          actions={<span className="mono">{opportunity.detectorVersion}</span>}
        />

        <div className="metric-strip">
          <div className="metric is-potential">
            <div className="m-label">Recoverable<span className="m-tag">Potential</span></div>
            <div className="m-value">{formatRupees(opportunity.recoverableAmountPaise)}</div>
            <div className="m-note">Detected from merchant history</div>
          </div>
          <div className="metric">
            <div className="m-label">Affected customers</div>
            <div className="m-value">{opportunity.affectedCustomerCount}</div>
            <div className="m-note">{opportunity.targets.length} failed transactions</div>
          </div>
          <div className="metric">
            <div className="m-label">Excluded</div>
            <div className="m-value">{excludedTotal}</div>
            <div className="m-note">Failed, but not recoverable</div>
          </div>
          <div className="metric">
            <div className="m-label">Strategies scored</div>
            <div className="m-value">{opportunity.estimates.length}</div>
            <div className="m-note">Deterministic estimator</div>
          </div>
        </div>

        {/* ------------------------------ qualified vs deliberately excluded */}
        <div className="grid" style={{ alignItems: "start", marginTop: "var(--s-4)" }}>
          <div className="col-6">
            <div className="panel">
              <div className="panel-head"><h2>Why these qualified</h2></div>
              <table>
                <thead><tr><th>Failure reason</th><th className="num">Count</th></tr></thead>
                <tbody>
                  {Object.entries(opportunity.failureReasonBreakdown).map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{reason.toLowerCase().replaceAll("_", " ")}</td>
                      <td className="num money">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="col-6">
            <div className="panel">
              <div className="panel-head">
                <h2>Why the rest did not</h2>
                <span className="spacer" />
                <span className="mono">{excludedTotal} excluded</span>
              </div>
              <div className="panel-body" style={{ paddingBottom: 4 }}>
                <p className="panel-note" style={{ margin: 0 }}>
                  The detector discriminated rather than counting every failed payment.
                </p>
              </div>
              <table>
                <tbody>
                  {excluded.map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{reason.toLowerCase().replaceAll("_", " ")}</td>
                      <td className="num money">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* -------------------------------------------------------- scoring */}
        <div className="panel">
          <div className="panel-head">
            <h2>Deterministic strategies</h2>
            <span className="spacer" />
            <span className="mono">no model involved</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Playbook</th>
                  <th className="num">Recovery rate</th>
                  <th className="num">Expected gross</th>
                  <th className="num">Cost</th>
                  <th className="num">Expected net</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {opportunity.estimates.map((estimate) => (
                  <tr key={estimate.estimateId}>
                    <td>
                      <span style={{ fontWeight: 500, color: "var(--ink-900)" }}>
                        {estimate.playbookName}
                      </span>
                    </td>
                    <td className="num mono">{formatPercent(estimate.pRecoverAvgBps)}</td>
                    <td className="num mono">{formatRupees(estimate.expectedGrossPaise)}</td>
                    <td className="num mono">{formatRupees(estimate.costPaise)}</td>
                    <td className="num money">{formatRupees(estimate.expectedNetPaise)}</td>
                    <td><span className="badge badge-neutral">{estimate.confidence}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* --------------------------------------------------------- targets */}
        <div className="panel">
          <div className="panel-head">
            <h2>Targets</h2>
            <span className="badge badge-neutral">{opportunity.targets.length}</span>
          </div>
          <div className="panel-body" style={{ paddingBottom: 4 }}>
            <p className="panel-note" style={{ margin: 0 }}>
              Dataset references and tier only. No contact details are shown, because nothing
              on this page needs one.
            </p>
          </div>
          <div className="table-wrap">
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
                    <td className="num money">{formatRupees(target.amountPaise)}</td>
                    <td>{String(target.failureReason ?? "").toLowerCase().replaceAll("_", " ")}</td>
                    <td className="num">{target.failedAttemptNo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {opportunity.interventions.length > 0 && (
          <div className="panel">
            <div className="panel-head"><h2>Proposals</h2></div>
            <table>
              <tbody>
                {opportunity.interventions.map((intervention) => (
                  <tr key={intervention.id} className="clickable">
                    <td><span className="badge badge-neutral">{intervention.state}</span></td>
                    <td className="mono">{intervention.reasoningMode}</td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/interventions/${intervention.id}`} className="row-link">
                        Open decision packet<ArrowRight size={12} />
                      </Link>
                    </td>
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
