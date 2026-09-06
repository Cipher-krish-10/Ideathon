import { formatPercent, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getAnalytics } from "@/server/services/read.service";

export const dynamic = "force-dynamic";

/**
 * Analytics.
 *
 * Every figure is labelled ESTIMATE or ACTUAL. Conflating the two is the
 * easiest way for a demo to overstate what it achieved, so the page does not
 * put them in the same row without saying which is which.
 */
export default async function AnalyticsPage() {
  const session = await requireSession();
  const analytics = await getAnalytics(session.merchantId);

  const funnelRows = [
    ["Detected", analytics.funnel.detected, "opportunities found in the data"],
    ["Proposed", analytics.funnel.proposed, "the agent drafted an action"],
    ["Approved", analytics.funnel.approved, "a human said yes"],
    ["Executed", analytics.funnel.executed, "a payment link was created"],
    ["Converted", analytics.funnel.converted, "a verified payment was attributed"],
  ] as const;

  return (
    <main className="page">
      <h1>Analytics</h1>
      <p className="subtitle">
        Estimates and actuals, kept apart. Only <strong>recovered revenue</strong> reflects
        money that has genuinely arrived.
      </p>

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="metric">
          <div className="label">Opportunity value</div>
          <div className="value">{formatRupees(analytics.opportunityValuePaise)}</div>
          <div className="note">ESTIMATE · detected at risk</div>
        </div>
        <div className="metric">
          <div className="label">Expected net</div>
          <div className="value">{formatRupees(analytics.expectedNetPaise)}</div>
          <div className="note">ESTIMATE · estimator projection</div>
        </div>
        <div className="metric">
          <div className="label">Executed actions</div>
          <div className="value">{analytics.funnel.executed}</div>
          <div className="note">ACTUAL · links created at the provider</div>
        </div>
        <div className="metric">
          <div className="label">Recovered revenue</div>
          <div className="value" data-testid="analytics-recovered">
            {formatRupees(analytics.recoveredAmountPaise)}
          </div>
          <div className="note">ACTUAL · confirmed by payment events</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Funnel</h2>
          <table>
            <thead><tr><th>Stage</th><th className="num">Count</th><th>Meaning</th></tr></thead>
            <tbody>
              {funnelRows.map(([label, count, meaning]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num"><strong>{count}</strong></td>
                  <td className="muted" style={{ fontSize: 13 }}>{meaning}</td>
                </tr>
              ))}
              <tr>
                <td className="muted">Blocked by guardrails</td>
                <td className="num">{analytics.funnel.blocked}</td>
                <td className="muted" style={{ fontSize: 13 }}>stopped before acting</td>
              </tr>
              <tr>
                <td className="muted">Rejected</td>
                <td className="num">{analytics.funnel.rejected}</td>
                <td className="muted" style={{ fontSize: 13 }}>a human declined</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Attributed payments</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            A payment is counted only when attribution resolves confidently. Ambiguous
            evidence produces no credit at all.
          </p>
          <table>
            <tbody>
              <tr><td>Payments attributed</td><td className="num">{analytics.attributedPaymentCount}</td></tr>
              <tr><td>Recovered revenue</td><td className="num">{formatRupees(analytics.recoveredAmountPaise)}</td></tr>
              <tr><td>Qualifying customers detected</td><td className="num">{analytics.qualifyingCustomers}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Playbook learning</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Seeded priors versus what has actually been observed. The next estimator run reads
          the current rate, so an outcome here changes what the agent proposes next.
        </p>
        <div className="table-scroll">
          <table data-testid="learning-table">
            <thead>
              <tr>
                <th>Playbook</th><th className="num">Seeded rate</th><th className="num">Current rate</th>
                <th className="num">Conversions</th><th className="num">Non-conversions</th>
                <th className="num">Observations</th>
              </tr>
            </thead>
            <tbody>
              {analytics.playbooks.map((playbook) => {
                const moved = playbook.currentRateBps !== playbook.seededRateBps;
                return (
                  <tr key={playbook.key}>
                    <td>{playbook.name}<div className="mono">{playbook.key}</div></td>
                    <td className="num muted">
                      {playbook.hasPrior ? formatPercent(playbook.seededRateBps) : "—"}
                    </td>
                    <td className="num">
                      {playbook.hasPrior ? (
                        <strong style={{ color: moved ? "var(--accent)" : undefined }}>
                          {formatPercent(playbook.currentRateBps)}
                        </strong>
                      ) : "—"}
                    </td>
                    <td className="num">{playbook.conversions}</td>
                    <td className="num">{playbook.nonConversions}</td>
                    <td className="num">{playbook.observations}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
