import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";

import { TopBar } from "@/components/layout/topbar";
import { formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth/session";
import { listAuditEntries } from "@/server/services/read.service";
import { getSimulationState } from "@/server/services/simulation";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await requireSession();
  const [audit, simulation] = await Promise.all([
    listAuditEntries(session.merchantId, 200),
    getSimulationState(session.merchantId),
  ]);

  return (
    <>
      <TopBar
        title="Audit"
        subtitle="Append-only and hash-chained — each entry commits to its predecessor"
        agentStatus={simulation.status}
        showRunAgent={false}
      />
      <div className="content">
        {/* The trust claim, made verifiable rather than asserted. */}
        <div
          className="card"
          style={{
            background: audit.verified
              ? "linear-gradient(135deg, var(--ok-50), #ffffff 62%)"
              : "linear-gradient(135deg, var(--stop-50), #ffffff 62%)",
            borderColor: audit.verified ? "#bce8cd" : "#f3c4c1",
          }}
        >
          <div className="row" style={{ gap: 16 }}>
            <div
              style={{
                width: 46, height: 46, borderRadius: 14, display: "grid", placeItems: "center",
                background: audit.verified ? "var(--ok-500)" : "var(--stop-500)", color: "#fff",
              }}
            >
              {audit.verified ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
            </div>
            <div>
              <div
                style={{
                  fontSize: 11, letterSpacing: ".11em", textTransform: "uppercase",
                  fontWeight: 700, color: "var(--ink-400)",
                }}
              >
                Audit chain
              </div>
              {/* One element, one phrase: the trust claim reads as a sentence. */}
              <div style={{ fontSize: 24, fontWeight: 660, letterSpacing: "-.028em", marginTop: 2 }}>
                {audit.verified ? "Integrity verified" : "Chain broken"}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {audit.entryCount} events recomputed from scratch. Editing history
                invalidates every entry after it.
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>System timeline</h2></div>
          {audit.entries.length === 0 ? (
            <div className="empty">
              <div className="big">No audited events yet</div>
              Run the agent to begin the session record.
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th><th>Actor</th><th>Action</th>
                    <th>Entity</th><th>When</th><th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.entries.map((entry) => (
                    <tr key={entry.seq}>
                      <td className="num mono">{entry.seq}</td>
                      <td><span className="badge badge-neutral">{entry.actorType}</span></td>
                      <td>{entry.action.replaceAll("_", " ").toLowerCase()}</td>
                      <td className="muted">{entry.entityType}</td>
                      <td className="mono">{formatDateTime(entry.createdAt)}</td>
                      <td className="mono">
                        <span className="row" style={{ gap: 5 }}>
                          <CheckCircle2 size={12} color="var(--ok-500)" />{entry.hash}…
                        </span>
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
