import { Zap } from "lucide-react";

import { TopBar } from "@/components/layout/topbar";
import { decisionPill, formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listInterventions } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

export default async function InterventionsPage() {
  const session = await requireSession();
  const [interventions, simulation] = await Promise.all([
    listInterventions(session.merchantId),
    getSimulationState(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        title="Interventions"
        subtitle="Every proposal the agent has made in this session"
        agentStatus={simulation.status}
      />
      <div className="content">
        <div className="card">
          {interventions.length === 0 ? (
            <div className="empty">
              <Zap size={26} color="var(--ink-300)" style={{ marginBottom: 10 }} />
              <div className="big">No interventions yet</div>
              Run the agent from the Command Centre to produce a proposal.
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>State</th><th>Playbook</th><th className="num">Customers</th>
                    <th className="num">Expected net</th><th>Confidence</th>
                    <th>Reasoning</th><th>Created</th><th />
                  </tr>
                </thead>
                <tbody>
                  {interventions.map((intervention) => (
                    <tr key={intervention.id}>
                      <td><span className={decisionPill(intervention.state)}>{intervention.state}</span></td>
                      <td>{intervention.playbookName}</td>
                      <td className="num">{intervention.targetCount}</td>
                      <td className="num"><strong>{formatRupees(intervention.expectedNetPaise)}</strong></td>
                      <td><span className="badge badge-neutral">{intervention.confidence}</span></td>
                      <td>
                        <span className={intervention.reasoningMode === "LLM" ? "badge badge-ai" : "badge badge-neutral"}>
                          {intervention.reasoningMode}
                        </span>
                      </td>
                      <td className="mono">{formatDateTime(intervention.createdAt)}</td>
                      <td><a href={`/interventions/${intervention.id}`}>Open →</a></td>
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
