import Link from "next/link";
import { ArrowRight, Filter, Target, XCircle } from "lucide-react";

import { TopBar } from "@/components/layout/topbar";
import { formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listOpportunities } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const session = await requireSession();
  const [opportunities, simulation] = await Promise.all([
    listOpportunities(session.merchantId),
    getSimulationState(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        title="Opportunities"
        subtitle="Detected from the merchant's payment history — counted facts, no projections"
        agentStatus={simulation.status}
      />
      <div className="content">
        {opportunities.length === 0 ? (
          <div className="card">
            <div className="empty">
              <Target size={26} color="var(--ink-300)" style={{ marginBottom: 10 }} />
              <div className="big">No recoverable opportunities</div>
              RevenuePilot found no recoverable opportunities in the current merchant
              baseline. Run the agent to scan again.
            </div>
          </div>
        ) : (
          opportunities.map((opportunity) => {
            const excluded = Object.entries(opportunity.exclusionCounts)
              .filter(([, count]) => count > 0);
            return (
              <div className="card" key={opportunity.id}>
                <div className="card-head">
                  <h2>Failed payment recovery</h2>
                  <span className="badge badge-blue">{opportunity.status}</span>
                  <span className="spacer" />
                  <span className="mono">{opportunity.detectorVersion}</span>
                </div>

                <div className="kpi-grid" style={{ marginBottom: "var(--s-5)" }}>
                  <div className="kpi kpi-historical" style={{ boxShadow: "none" }}>
                    <span className="kpi-tag">Potential</span>
                    <div className="label">Recoverable</div>
                    <div className="value">{formatRupees(opportunity.recoverableAmountPaise)}</div>
                    <div className="note">Detected from merchant history</div>
                  </div>
                  <div className="kpi kpi-historical" style={{ boxShadow: "none" }}>
                    <div className="label">Affected customers</div>
                    <div className="value">{opportunity.affectedCustomerCount}</div>
                    <div className="note">{opportunity.targetCount} transactions</div>
                  </div>
                  <div className="kpi kpi-historical" style={{ boxShadow: "none" }}>
                    <div className="label">Detected</div>
                    <div className="value" style={{ fontSize: 17 }}>
                      {formatDateTime(opportunity.detectedAt)}
                    </div>
                    <div className="note">{opportunity.estimateCount} strategies scored</div>
                  </div>
                </div>

                <div className="grid-2">
                  <div>
                    <label style={{ marginTop: 0 }}>Why these qualified</label>
                    <div className="row" style={{ gap: 6 }}>
                      {Object.entries(opportunity.failureReasonBreakdown).map(([reason, count]) => (
                        <span key={reason} className="badge badge-blue">
                          {reason.toLowerCase().replaceAll("_", " ")} · {count}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={{ marginTop: 0 }}>
                      Why the rest did not — the agent discriminated
                    </label>
                    <div className="row" style={{ gap: 6 }}>
                      {excluded.map(([reason, count]) => (
                        <span key={reason} className="badge badge-neutral">
                          <XCircle />{reason.toLowerCase().replaceAll("_", " ")} · {count}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="actions">
                  <Link className="btn" href={`/opportunities/${opportunity.id}`}>
                    <Filter size={14} />View evidence
                  </Link>
                  {opportunity.interventionCount > 0 && (
                    <Link className="btn primary" href="/interventions">
                      View {opportunity.interventionCount} proposal(s)<ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
