import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listAuditEntries } from "@/server/services/read.service";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await requireSession();
  const audit = await listAuditEntries(session.merchantId, 200);

  return (
    <main className="page">
      <h1>Audit</h1>
      <p className="subtitle">
        Append-only and hash-chained. Each entry commits to its predecessor, so editing
        history invalidates every entry after it.
      </p>

      <div className={audit.verified ? "banner banner-ok" : "banner banner-block"}>
        <strong>{audit.verified ? "Integrity verified" : "Chain broken"}</strong>
        {audit.entryCount} entries recomputed from scratch.
      </div>

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>#</th><th>Actor</th><th>Entity</th><th>Action</th><th>When</th><th>Hash</th></tr>
            </thead>
            <tbody>
              {audit.entries.map((entry) => (
                <tr key={entry.seq}>
                  <td className="mono">{entry.seq}</td>
                  <td><span className="pill pill-muted">{entry.actorType}</span></td>
                  <td>{entry.entityType}</td>
                  <td>{entry.action.replaceAll("_", " ").toLowerCase()}</td>
                  <td className="mono">{formatDateTime(entry.createdAt)}</td>
                  <td className="mono">{entry.hash}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
