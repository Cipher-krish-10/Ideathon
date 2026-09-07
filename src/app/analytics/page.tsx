import { FunnelChart } from "@/components/analytics/funnel-chart";
import { PageHeader, TopBar } from "@/components/layout/topbar";
import { formatPercent, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getAnalytics } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

/**
 * Analytics.
 *
 * Every figure is labelled ESTIMATE or ACTUAL, and the two are never placed in
 * the same row without saying which is which. Conflating them is the easiest
 * way for a demo to overstate what it achieved.
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
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Analytics" }]}
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">
        <PageHeader
          title="Analytics"
          subtitle="Four different quantities, deliberately never added together. Only recovered revenue is money that has genuinely arrived."
        />

        {/* ------------------------------------------------- metric strip */}
        <div className="metric-strip">
          <div className="metric is-potential">
            <div className="m-label">Opportunity<span className="m-tag">Potential</span></div>
            <div className="m-value" data-testid="analytics-opportunity">
              {formatRupees(analytics.opportunityValuePaise)}
            </div>
            <div className="m-note">
              POTENTIAL · detected in the merchant&apos;s synthetic payment history
            </div>
          </div>
          <div className="metric is-estimate">
            <div className="m-label">Expected<span className="m-tag">Est</span></div>
            <div className="m-value">{formatRupees(analytics.expectedNetPaise)}</div>
            <div className="m-note">ESTIMATE · what the estimator projected</div>
          </div>
          <div className="metric is-actual">
            <div className="m-label">Executed<span className="m-tag actual">Actual</span></div>
            <div className="m-value">{analytics.funnel.executed}</div>
            <div className="m-note">ACTUAL · links created at the provider</div>
          </div>
          <div className="metric is-actual">
            <div className="m-label">Recovered<span className="m-tag actual">Actual</span></div>
            <div className="m-value" data-testid="analytics-recovered">
              {formatRupees(analytics.recoveredAmountPaise)}
            </div>
            <div className="m-note">ACTUAL · the only figure called revenue</div>
          </div>
        </div>

        {/* ------------------------------------------------------- funnel */}
        <div className="grid" style={{ alignItems: "start", marginTop: "var(--s-4)" }}>
          <div className="col-8">
            <div className="panel">
              <div className="panel-head">
                <h2>Recovery funnel</h2>
                <span className="spacer" />
                <span className="mono">{analytics.qualifyingCustomers} qualifying customers</span>
              </div>
              <div className="panel-body">
                <FunnelChart
                  stages={funnelRows.map(([label, count, meaning]) => ({ label, count, meaning }))}
                  blocked={analytics.funnel.blocked}
                  rejected={analytics.funnel.rejected}
                />
              </div>
            </div>
          </div>

          <div className="col-4">
            <div className="panel">
              <div className="panel-head"><h2>Attributed payments</h2></div>
              <div className="panel-body" style={{ paddingBottom: 8 }}>
                <p className="panel-note">
                  A payment counts only when attribution resolves confidently. Ambiguous
                  evidence produces no credit at all.
                </p>
              </div>
              <table>
                <tbody>
                  <tr>
                    <td>Payments attributed</td>
                    <td className="num money">{analytics.attributedPaymentCount}</td>
                  </tr>
                  <tr>
                    <td>Recovered revenue</td>
                    <td className="num money">{formatRupees(analytics.recoveredAmountPaise)}</td>
                  </tr>
                  <tr>
                    <td>Qualifying customers</td>
                    <td className="num money">{analytics.qualifyingCustomers}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------- learning */}
        <div className="panel">
          <div className="panel-head">
            <h2>Playbook learning</h2>
            <span className="spacer" />
            <span className="mono">Beta posterior per playbook</span>
          </div>
          <div className="panel-body" style={{ paddingBottom: 8 }}>
            <p className="panel-note" style={{ margin: 0 }}>
              Seeded priors versus what has actually been observed. The next estimator run reads
              the current rate, so an outcome here changes what the agent proposes next.
            </p>
          </div>
          <div className="table-wrap">
            <table data-testid="learning-table">
              <thead>
                <tr>
                  <th>Playbook</th>
                  <th className="num">Seeded rate</th>
                  <th className="num">Current rate</th>
                  <th className="num">Conversions</th>
                  <th className="num">Non-conversions</th>
                  <th className="num">Observations</th>
                </tr>
              </thead>
              <tbody>
                {analytics.playbooks.map((playbook) => {
                  const moved = playbook.currentRateBps !== playbook.seededRateBps;
                  return (
                    <tr key={playbook.key}>
                      <td>
                        <span style={{ fontWeight: 500, color: "var(--ink-900)" }}>
                          {playbook.name}
                        </span>
                        <span className="mono" style={{ display: "block" }}>{playbook.key}</span>
                      </td>
                      <td className="num muted">
                        {playbook.hasPrior ? formatPercent(playbook.seededRateBps) : "—"}
                      </td>
                      <td className="num">
                        {playbook.hasPrior ? (
                          <strong style={{ color: moved ? "var(--blue-600)" : undefined }}>
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
