import { decisionPill, formatDateTime, formatRupees } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listInterventions } from "@/server/services/read.service";

export const dynamic = "force-dynamic";

export default async function InterventionsPage() {
  const session = await requireSession();
  const interventions = await listInterventions(session.merchantId);

  return (
    <main className="page">
      <h1>Interventions</h1>
      <p className="subtitle">
        Every proposal the agent has made. Nothing here has executed — that phase does not exist yet.
      </p>

      <div className="card">
        {interventions.length === 0 ? (
          <p className="empty">No interventions yet. Run the agent from the Command Centre.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>State</th><th>Playbook</th><th>Customers</th>
                  <th className="num">Expected net</th><th>Reasoning</th><th>Created</th><th />
                </tr>
              </thead>
              <tbody>
                {interventions.map((intervention) => (
                  <tr key={intervention.id}>
                    <td><span className={decisionPill(intervention.state)}>{intervention.state}</span></td>
                    <td>{intervention.playbookName}</td>
                    <td>{intervention.targetCount}</td>
                    <td className="num">{formatRupees(intervention.expectedNetPaise)}</td>
                    <td className="mono">{intervention.reasoningMode}</td>
                    <td className="mono">{formatDateTime(intervention.createdAt)}</td>
                    <td><a href={`/interventions/${intervention.id}`}>Open →</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
