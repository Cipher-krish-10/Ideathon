import { FunnelChart } from "@/components/analytics/funnel-chart";
import { TopBar } from "@/components/layout/topbar";
import { formatPercent, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getAnalytics } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

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
  const [analytics, simulation] = await Promise.all([
    getAnalytics(session.merchantId),
    getSimulationState(session.merchantId),
  ]);

  const funnelRows = [
    ["Detected", analytics.funnel.detected, "opportunities found in the data"],
    ["Proposed", analytics.funnel.proposed, "the agent drafted an action"],
    ["Approved", analytics.funnel.approved, "a human said yes"],
    ["Executed", analytics.funnel.executed, "a payment link was created"],
    ["Converted", analytics.funnel.converted, "a verified payment was attributed"],
  ] as const;

  return (
    <>
      <TopBar
        title="Analytics"
        subtitle="Estimates and actuals, deliberately never added together"
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">
      <p className="subtitle">
        Four different things, deliberately never added together. Only{" "}
        <strong>recovered revenue</strong> is money that has genuinely arrived.
      </p>

      <div className="section-label">Historical merchant baseline</div>
      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        <div className="metric historical">
          <div className="label">Historical opportunity</div>
          <div className="value" data-testid="analytics-opportunity">
            {formatRupees(analytics.opportunityValuePaise)}
          </div>
          <div className="note">
            POTENTIAL · detected in the merchant&apos;s synthetic payment history
          </div>
        </div>
        <div className="metric historical">
          <div className="label">Qualifying customers</div>
          <div className="value">{analytics.qualifyingCustomers}</div>
          <div className="note">Detected from merchant history</div>
        </div>
      </div>

      <div className="section-label">This demo session</div>
      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="metric projected">
          <div className="label">Expected recovery</div>
          <div className="value">{formatRupees(analytics.expectedNetPaise)}</div>
          <div className="note">ESTIMATE · what the estimator projected</div>
        </div>
        <div className="metric actual">
          <div className="label">Executed actions</div>
          <div className="value">{analytics.funnel.executed}</div>
          <div className="note">ACTUAL · links created at the provider</div>
        </div>
        <div className="metric actual">
          <div className="label">Payments attributed</div>
          <div className="value">{analytics.attributedPaymentCount}</div>
          <div className="note">ACTUAL · verified payment events</div>
        </div>
        <div className="metric actual">
          <div className="label">Actual recovered</div>
          <div className="value" data-testid="analytics-recovered">
            {formatRupees(analytics.recoveredAmountPaise)}
          </div>
          <div className="note">ACTUAL · the only figure called revenue</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Recovery funnel</h2></div>
          <FunnelChart
            stages={funnelRows.map(([label, count, meaning]) => ({ label, count, meaning }))}
            blocked={analytics.funnel.blocked}
            rejected={analytics.funnel.rejected}
          />
        </div>

        <div className="card">
          <div className="card-head"><h2>Attributed payments</h2></div>
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
        <div className="card-head"><h2>Playbook learning</h2></div>
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
      </div>
    </>
  );
}
