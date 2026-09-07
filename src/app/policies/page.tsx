import { PolicyEditor } from "@/components/policy-editor";
import { TopBar } from "@/components/layout/topbar";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getPolicySnapshot } from "@/server/services/policy.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const session = await requireSession();
  const [snapshot, simulation] = await Promise.all([
    getPolicySnapshot(session.merchantId),
    getSimulationState(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        title="Policies"
        subtitle="The deterministic limits that gate every money action"
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">

      {snapshot && (
        <PolicyEditor activeVersion={snapshot.activeVersion} rules={snapshot.rules} />
      )}

      <div className="card">
        <div className="card-head"><h2>Version history</h2></div>
        <table>
          <thead><tr><th>Version</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {snapshot?.versions.map((version) => (
              <tr key={version.version}>
                <td className="mono">v{version.version}</td>
                <td>
                  <span className={version.isActive ? "badge badge-ok" : "badge badge-neutral"}>
                    {version.isActive ? "active" : "superseded"}
                  </span>
                </td>
                <td className="mono">{formatDateTime(version.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}
