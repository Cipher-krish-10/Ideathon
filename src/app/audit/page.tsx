import { ShieldAlert, ShieldCheck } from "lucide-react";

import { PageHeader, TopBar } from "@/components/layout/topbar";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listAuditEntries } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";
import { getSessionProjection } from "@/server/services/simulation/session-time";

export const dynamic = "force-dynamic";

/**
 * Audit console.
 *
 * A compliance surface. The integrity claim is stated once, at the top, and it
 * is verifiable rather than asserted: the chain is recomputed from scratch on
 * every request, so "verified" means the server just proved it.
 */
export default async function AuditPage() {
  const session = await requireSession();
  const [audit, simulation, clock] = await Promise.all([
    listAuditEntries(session.merchantId, 200),
    getSimulationState(session.merchantId),
    getSessionProjection(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        crumbs={[{ label: "Nimbus Commerce", href: "/" }, { label: "Audit" }]}
        agentStatus={simulation.status}
        simulatedNow={clock.now().toISOString()}
        showRunAgent={false}
      />
      <div className="content">
        <PageHeader
          title="Audit"
          subtitle="Append-only and hash-chained. Each entry commits to its predecessor, so editing history invalidates every entry after it."
        />

        {/* The trust claim, made verifiable rather than decorative. */}
        {/* The trust claim, stated once and prominently — it is the reason
            this page exists, and it is verifiable rather than asserted. */}
        <div className={`integrity ${audit.verified ? "ok" : "bad"}`}>
          <span className="ico">
            {audit.verified ? <ShieldCheck size={19} /> : <ShieldAlert size={19} />}
          </span>
          <span className="integrity-text">
            <span className="integrity-kicker">Audit integrity</span>
            <span className="integrity-verdict">
              {audit.verified ? "Verified" : "Chain broken"}
            </span>
          </span>
          <span className="integrity-facts">
            <span><b>{audit.entryCount}</b> events</span>
            <span>SHA-256 chain {audit.verified ? "intact" : "broken"}</span>
            <span>recomputed on this request</span>
          </span>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Event stream</h2>
            <span className="badge badge-neutral">{audit.entries.length}</span>
            <span className="spacer" />
            <span className="mono">newest first</span>
          </div>

          {audit.entries.length === 0 ? (
            <div className="empty">
              <div className="big">No audited events yet</div>
              Run the agent to begin the session record.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Seq</th>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Event</th>
                    <th>Entity</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.entries.map((entry) => (
                    <tr key={entry.seq}>
                      <td className="num mono">{entry.seq}</td>
                      <td className="mono">{formatDateTime(entry.createdAt)}</td>
                      <td><span className="badge badge-neutral">{entry.actorType}</span></td>
                      <td style={{ color: "var(--ink-900)" }}>
                        {entry.action.replaceAll("_", " ").toLowerCase()}
                      </td>
                      <td className="muted">{entry.entityType}</td>
                      <td className="mono">{entry.hash}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="panel-foot">
            <span className="muted" style={{ fontSize: 11.5 }}>
              Entries are written by the application, never by hand. The database rejects
              every UPDATE and every DELETE that is not an explicit purge.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
