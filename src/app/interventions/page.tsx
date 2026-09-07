import Link from "next/link";
import { ArrowRight, Zap } from "lucide-react";

import { PageHeader, TopBar } from "@/components/layout/topbar";
import { decisionPill, formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listInterventions } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";
import { getSessionProjection } from "@/server/services/simulation/session-time";

export const dynamic = "force-dynamic";

/**
 * Interventions.
 *
 * The agent's proposal queue. State comes first because it is what determines
 * whether the merchant has anything to do, and the reasoning column says
 * plainly whether a model was involved in each one.
 */
export default async function InterventionsPage() {
  const session = await requireSession();
  const [interventions, simulation, clock] = await Promise.all([
    listInterventions(session.merchantId),
    getSimulationState(session.merchantId),
    getSessionProjection(session.merchantId),
  ]);

  const pending = interventions.filter((i) => i.state === "PENDING_APPROVAL").length;

  return (
    <>
      <TopBar
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Interventions" }]}
        agentStatus={simulation.status}
        simulatedNow={clock.now().toISOString()}
      />
      <div className="content">
        <PageHeader
          title="Interventions"
          subtitle="Every action the agent has proposed in this session, and where each one stands."
        />

        <div className="panel">
          <div className="panel-head">
            <h2>Proposals</h2>
            <span className="badge badge-neutral">{interventions.length}</span>
            {pending > 0 && (
              <span className="badge badge-warn">{pending} awaiting approval</span>
            )}
          </div>

          {interventions.length === 0 ? (
            <div className="empty">
              <Zap size={24} />
              <div className="big">No interventions yet</div>
              Run the agent from the command centre to produce a proposal.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Playbook</th>
                    <th className="num">Customers</th>
                    <th className="num">Expected net</th>
                    <th>Confidence</th>
                    <th>Reasoning</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {interventions.map((intervention) => (
                    <tr key={intervention.id} className="clickable">
                      <td>
                        <span className={decisionPill(intervention.state)}>
                          {intervention.state.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>
                        <Link href={`/interventions/${intervention.id}`} style={{ color: "inherit" }}>
                          <span style={{ fontWeight: 500, color: "var(--ink-900)" }}>
                            {intervention.playbookName}
                          </span>
                        </Link>
                      </td>
                      <td className="num">{intervention.targetCount}</td>
                      <td className="num money">{formatRupees(intervention.expectedNetPaise)}</td>
                      <td><span className="badge badge-neutral">{intervention.confidence}</span></td>
                      <td>
                        <span className={
                          intervention.reasoningMode === "LLM" ? "badge badge-ai" : "badge badge-neutral"
                        }>
                          {intervention.reasoningMode}
                        </span>
                      </td>
                      <td className="mono">{formatDateTime(intervention.createdAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link href={`/interventions/${intervention.id}`} className="row-link">
                          Open <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
