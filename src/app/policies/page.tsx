import { PolicyEditor } from "@/components/policy-editor";
import { PageHeader, TopBar } from "@/components/layout/topbar";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getPolicySnapshot } from "@/server/services/policy.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

/**
 * Policy centre.
 *
 * The deterministic limits that gate every money action. Editing creates a new
 * version rather than mutating the active one, so a guardrail evaluation that
 * recorded "policy v1" keeps meaning exactly what it meant.
 */
export default async function PoliciesPage() {
  const session = await requireSession();
  const [snapshot, simulation] = await Promise.all([
    getPolicySnapshot(session.merchantId),
    getSimulationState(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Policies" }]}
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">
        <PageHeader
          title="Policies"
          subtitle="The deterministic limits that gate every money action. The agent cannot exceed them, and it cannot edit them."
        />

        <div className="grid" style={{ alignItems: "start" }}>
          <div className="col-8">
            {snapshot && (
              <PolicyEditor activeVersion={snapshot.activeVersion} rules={snapshot.rules} />
            )}
          </div>

          <div className="col-4">
            <div className="panel">
              <div className="panel-head">
                <h2>Version history</h2>
                <span className="spacer" />
                <span className="mono">{snapshot?.versions.length ?? 0}</span>
              </div>
              <table>
                <thead>
                  <tr><th>Version</th><th>Status</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {snapshot?.versions.map((version) => (
                    <tr key={version.version}>
                      <td className="mono">v{version.version}</td>
                      <td>
                        <span className={version.isActive ? "pill pill-pass" : "pill pill-muted"}>
                          {version.isActive ? "active" : "superseded"}
                        </span>
                      </td>
                      <td className="mono">{formatDateTime(version.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="panel-foot">
                <span className="muted" style={{ fontSize: 11.5 }}>
                  A policy is never mutated in place. Superseded versions stay readable so
                  past evaluations remain interpretable.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
