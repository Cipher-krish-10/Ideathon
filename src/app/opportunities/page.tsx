import { RunAgentButton } from "@/components/run-agent-button";
import { formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listOpportunities } from "@/server/services/read.service";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const session = await requireSession();
  const opportunities = await listOpportunities(session.merchantId);

  return (
    <main className="page">
      <h1>Opportunities</h1>
      <p className="subtitle">Detected from raw payment records. Counted facts only — no projections.</p>

      <div className="card"><RunAgentButton /></div>

      {opportunities.length === 0 ? (
        <div className="card"><p className="empty">No opportunities detected yet. Run the agent.</p></div>
      ) : (
        opportunities.map((opportunity) => (
          <div className="card" key={opportunity.id}>
            <h2>
              Failed payment recovery
              <span className="pill pill-muted">{opportunity.status}</span>
            </h2>
            <div className="row" style={{ gap: 32, marginBottom: 12 }}>
              <div>
                <div className="label">Customers</div>
                <div style={{ fontSize: 21, fontWeight: 650 }}>{opportunity.affectedCustomerCount}</div>
              </div>
              <div>
                <div className="label">Recoverable</div>
                <div style={{ fontSize: 21, fontWeight: 650 }}>
                  {formatRupees(opportunity.recoverableAmountPaise)}
                </div>
              </div>
              <div>
                <div className="label">Detected</div>
                <div className="mono" style={{ marginTop: 8 }}>{formatDateTime(opportunity.detectedAt)}</div>
              </div>
            </div>
            <a href={`/opportunities/${opportunity.id}`}>View evidence →</a>
          </div>
        ))
      )}
    </main>
  );
}
