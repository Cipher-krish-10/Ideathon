import Link from "next/link";
import { ArrowRight, Target } from "lucide-react";

import { PageHeader, TopBar } from "@/components/layout/topbar";
import { formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listOpportunities } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";
import { getSessionProjection } from "@/server/services/simulation/session-time";

export const dynamic = "force-dynamic";

/**
 * Opportunity workspace.
 *
 * A worklist, not a gallery. Each row is one detected opportunity with the
 * facts a merchant triages on — value, reach, dominant failure mode, status —
 * and the evidence sits one click away rather than expanded inline.
 */
export default async function OpportunitiesPage() {
  const session = await requireSession();
  const [opportunities, simulation, clock] = await Promise.all([
    listOpportunities(session.merchantId),
    getSimulationState(session.merchantId),
    getSessionProjection(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Opportunities" }]}
        agentStatus={simulation.status}
        simulatedNow={clock.now().toISOString()}
      />
      <div className="content">
        <PageHeader
          title="Opportunities"
          subtitle="Recoverable revenue detected in the merchant's payment history. Counted facts — no projections on this page."
        />

        {opportunities.length === 0 ? (
          <div className="panel">
            <div className="empty">
              <Target size={24} />
              <div className="big">No recoverable opportunities</div>
              RevenuePilot found nothing recoverable in the current merchant baseline.
              Run the agent to scan again.
            </div>
          </div>
        ) : (
          <div className="panel">
            <div className="panel-head">
              <h2>Detected opportunities</h2>
              <span className="badge badge-neutral">{opportunities.length}</span>
              <span className="spacer" />
              <span className="mono">{opportunities[0]?.detectorVersion}</span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Opportunity</th>
                    <th className="num">Customers</th>
                    <th className="num">Potential value</th>
                    <th>Primary issue</th>
                    <th>Status</th>
                    <th>Detected</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {opportunities.map((opportunity) => {
                    // The dominant failure mode, chosen by count. Presentation
                    // only — the breakdown itself comes from the detector.
                    const reasons = Object.entries(opportunity.failureReasonBreakdown)
                      .sort((a, b) => b[1] - a[1]);
                    const [topReason, topCount] = reasons[0] ?? ["—", 0];
                    const others = reasons.length - 1;

                    return (
                      <tr key={opportunity.id} className="clickable">
                        <td>
                          <Link href={`/opportunities/${opportunity.id}`}
                                style={{ color: "inherit" }}>
                            <span style={{ fontWeight: 550, color: "var(--ink-900)" }}>
                              Failed payment recovery
                            </span>
                            <span className="mono" style={{ display: "block" }}>
                              {opportunity.targetCount} failed transactions
                            </span>
                          </Link>
                        </td>
                        <td className="num">{opportunity.affectedCustomerCount}</td>
                        <td className="num money">
                          {formatRupees(opportunity.recoverableAmountPaise)}
                        </td>
                        <td>
                          <span className="badge badge-neutral">
                            {topReason.toLowerCase().replaceAll("_", " ")} · {topCount}
                          </span>
                          {others > 0 && (
                            <span className="mono" style={{ marginLeft: 6 }}>+{others}</span>
                          )}
                        </td>
                        <td><span className="pill pill-accent">{opportunity.status}</span></td>
                        <td className="mono">{formatDateTime(opportunity.detectedAt)}</td>
                        <td style={{ textAlign: "right" }}>
                          <Link href={`/opportunities/${opportunity.id}`} className="row-link">
                            Evidence<ArrowRight size={12} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="panel-foot">
              <span className="muted" style={{ fontSize: 12 }}>
                Every figure here is counted from the merchant&apos;s own payment history.
                Nothing on this page is a projection.
              </span>
              {opportunities.some((o) => o.interventionCount > 0) && (
                <>
                  <span className="spacer" />
                  <Link className="btn sm" href="/interventions">
                    View proposals<ArrowRight size={12} />
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
