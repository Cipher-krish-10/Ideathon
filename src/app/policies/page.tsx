import { PolicyEditor } from "@/components/policy-editor";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { getPolicySnapshot } from "@/server/services/policy.service";

export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const session = await requireSession();
  const snapshot = await getPolicySnapshot(session.merchantId);

  return (
    <main className="page">
      <h1>Policies</h1>
      <p className="subtitle">
        The deterministic limits that gate every money action. The reasoning model can
        cite these; it cannot change them.
      </p>

      {snapshot && (
        <PolicyEditor activeVersion={snapshot.activeVersion} rules={snapshot.rules} />
      )}

      <div className="card">
        <h2>Version history</h2>
        <table>
          <thead><tr><th>Version</th><th>Status</th><th>Created</th></tr></thead>
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
      </div>
    </main>
  );
}
