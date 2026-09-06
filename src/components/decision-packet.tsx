"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { decisionPill, formatDateTime, formatPercent, formatRupees } from "@/lib/format";

/**
 * The decision packet.
 *
 * One screen holding everything a merchant needs to decide: what was found,
 * what the agent chose, what it rejected and why, what was checked, and exactly
 * what would be sent. No raw database JSON is shown anywhere.
 */

interface RuleResult {
  ruleId: string; label: string; severity: string; passed: boolean;
  observed: string; limit: string; message: string;
}
interface GuardrailEvaluation {
  id: string; phase: string; decision: string; policyVersion: number;
  evaluatedAt: string; results: RuleResult[];
}
interface EstimateView {
  estimateId: string; playbookKey: string; playbookName: string;
  expectedGrossPaise: number; costPaise: number; discountCostPaise: number;
  channelCostPaise: number; gatewayFeePaise: number; expectedNetPaise: number;
  pRecoverAvgBps: number; confidence: string; discountBps: number; isSelected?: boolean;
}

export interface DecisionPacketData {
  id: string; state: string; version: number; reasoningMode: string; mode: string;
  targetCount: number; createdAt: string; approvedAt: string | null; expiresAt: string | null;
  opportunity: {
    id: string; affectedCustomerCount: number; recoverableAmountPaise: number;
    detectorVersion: string; failureReasonBreakdown: Record<string, number>;
    exclusionCounts: Record<string, number>;
  };
  recommendation: {
    playbookKey: string; playbookName: string; actionType: string;
    rationale: string | null; risksIdentified: string[]; confidenceNote: string | null;
    estimate: EstimateView;
  };
  alternatives: EstimateView[];
  guardrails: GuardrailEvaluation[];
  customerMessage: { subject: string; body: string; editedAt: string | null };
  approval: { decision: string; note: string | null; decidedAt: string; approver: string } | null;
  attribution: {
    records: {
      id: string; method: string; confidence: string; attributedAmountPaise: number;
      note: string | null; attributedAt: string; providerEventId: string | null;
      simulated: boolean;
    }[];
    recoveredAmountPaise: number;
  };
  execution: {
    artifacts: {
      id: string; providerEntityId: string; shortUrl: string;
      amountPaise: number; status: string; createdAt: string;
    }[];
    attempts: {
      attemptNo: number; status: string; responseStatus: number | null;
      error: string | null; idempotencyKey: string; startedAt: string;
    }[];
    totalAmountPaise: number;
  };
  reasoning: {
    id: string; provider: string; model: string; attemptNo: number; isValid: boolean;
    outcome: string; latencyMs: number; issues: { field: string; message: string }[];
  }[];
  auditTimeline: { seq: number; actorType: string; action: string; createdAt: string }[];
}

const DECIDABLE_STATES = ["PENDING_APPROVAL", "PROPOSED"];

export function DecisionPacket({ packet }: { packet: DecisionPacketData }) {
  const router = useRouter();
  const [subject, setSubject] = useState(packet.customerMessage.subject);
  const [body, setBody] = useState(packet.customerMessage.body);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: "blocked"; rules: { ruleId: string; message: string }[] }
    | { kind: "approved" } | { kind: "rejected" }
    | { kind: "executed"; count: number } | { kind: "executionFailed"; message: string }
    | { kind: "error"; message: string } | null
  >(null);

  const decidable = DECIDABLE_STATES.includes(packet.state);
  // Approval is consent, not permission to act: the executor still re-runs the
  // guardrails. EXECUTION_FAILED is retryable; nothing else is.
  const executable = ["APPROVED", "EXECUTION_FAILED"].includes(packet.state);
  const hasExecuted = packet.execution.artifacts.length > 0;
  const converted = packet.attribution.records.length > 0;
  const awaitingPayment = hasExecuted && !converted;
  const edited =
    subject !== packet.customerMessage.subject || body !== packet.customerMessage.body;

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch(`/api/interventions/${packet.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "approve"
            ? { version: packet.version, ...(edited ? { editedMessage: { subject, body } } : {}) }
            : { version: packet.version, reason: "Rejected by approver in the demo flow." },
        ),
      });
      const payload = await response.json();

      if (!response.ok) {
        setOutcome({ kind: "error", message: payload.error?.message ?? "The request failed." });
        return;
      }
      if (payload.data.status === "BLOCKED") {
        setOutcome({ kind: "blocked", rules: payload.data.blockingRules ?? [] });
      } else if (payload.data.status === "APPROVED") {
        setOutcome({ kind: "approved" });
      } else if (payload.data.status === "REJECTED") {
        setOutcome({ kind: "rejected" });
      } else {
        setOutcome({ kind: "error", message: `Unexpected outcome: ${payload.data.status}` });
      }
      router.refresh();
    } catch {
      setOutcome({ kind: "error", message: "Could not reach the approval service." });
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch(`/api/interventions/${packet.id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: packet.version }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setOutcome({ kind: "error", message: payload.error?.message ?? "The request failed." });
        return;
      }
      if (payload.data.status === "BLOCKED") {
        setOutcome({ kind: "blocked", rules: payload.data.blockingRules ?? [] });
      } else if (payload.data.status === "EXECUTED") {
        setOutcome({ kind: "executed", count: payload.data.artifacts.length });
      } else {
        setOutcome({
          kind: "executionFailed",
          message: payload.data.errors?.[0]?.message ?? "Execution failed.",
        });
      }
      router.refresh();
    } catch {
      setOutcome({ kind: "error", message: "Could not reach the executor." });
    } finally {
      setBusy(false);
    }
  }

  async function simulate(artifactId: string) {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/simulate/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setOutcome({ kind: "error", message: payload.error?.message ?? "Simulation failed." });
        return;
      }
      router.refresh();
    } catch {
      setOutcome({ kind: "error", message: "Could not reach the simulator." });
    } finally {
      setBusy(false);
    }
  }

  const preApproval = packet.guardrails.filter((g) => g.phase === "PRE_APPROVAL").at(-1);
  const preExecution = packet.guardrails.filter((g) => g.phase === "PRE_EXECUTION").at(-1);

  return (
    <main className="page">
      <h1>Decision Packet</h1>
      <p className="subtitle">
        <span className={decisionPill(packet.state)}>{packet.state}</span>{" "}
        <span className="mono">
          {packet.targetCount} customers · reasoning {packet.reasoningMode} · v{packet.version}
        </span>
      </p>

      {outcome?.kind === "blocked" && (
        <div className="banner banner-block" data-testid="blocked-banner">
          <strong>Action blocked</strong>
          {outcome.rules.map((rule) => (
            <div key={rule.ruleId}>
              <span className="mono" data-testid="blocking-rule">{rule.ruleId}</span> — {rule.message}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>Nothing was sent and no money moved.</div>
        </div>
      )}
      {outcome?.kind === "approved" && (
        <div className="banner banner-ok" data-testid="approved-banner">
          <strong>Approved</strong>
          Recorded against your account. No money has moved — execution is a later phase.
        </div>
      )}
      {outcome?.kind === "executed" && (
        <div className="banner banner-ok" data-testid="executed-banner">
          <strong>Executed — {outcome.count} payment link(s) created in Razorpay Test Mode</strong>
          Payment link created — revenue has <strong>NOT</strong> yet been recovered.
          The links are awaiting payment.
        </div>
      )}
      {outcome?.kind === "executionFailed" && (
        <div className="banner banner-block" data-testid="execution-failed-banner">
          <strong>Execution failed</strong>{outcome.message}
          <div style={{ marginTop: 8 }}>No payment link was created. You can retry.</div>
        </div>
      )}
      {outcome?.kind === "rejected" && (
        <div className="banner banner-block" data-testid="rejected-banner">
          <strong>Rejected</strong>This proposal is closed.
        </div>
      )}
      {outcome?.kind === "error" && (
        <div className="banner banner-block" data-testid="error-banner">
          <strong>Could not complete</strong>{outcome.message}
        </div>
      )}

      {/* 1. Opportunity */}
      <div className="card">
        <h2>Opportunity</h2>
        <div className="row" style={{ gap: 32, marginBottom: 14 }}>
          <div>
            <div className="label">Customers</div>
            <div style={{ fontSize: 22, fontWeight: 650 }}>
              {packet.opportunity.affectedCustomerCount}
            </div>
          </div>
          <div>
            <div className="label">Recoverable</div>
            <div style={{ fontSize: 22, fontWeight: 650 }} data-testid="recoverable-amount">
              {formatRupees(packet.opportunity.recoverableAmountPaise)}
            </div>
          </div>
          <div>
            <div className="label">Detector</div>
            <div className="mono" style={{ marginTop: 8 }}>{packet.opportunity.detectorVersion}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {Object.entries(packet.opportunity.failureReasonBreakdown).map(([reason, count]) => (
            <span key={reason} className="pill pill-muted">{reason.toLowerCase()} · {count}</span>
          ))}
        </div>
      </div>

      {/* 2. AI recommendation */}
      <div className="card">
        <h2>
          AI Recommendation
          <span className="pill pill-accent">{packet.reasoningMode}</span>
        </h2>
        <p style={{ marginTop: 0 }}>
          <strong data-testid="selected-playbook">{packet.recommendation.playbookName}</strong>{" "}
          <span className="mono">({packet.recommendation.playbookKey})</span>
          {" · expected net "}
          <strong>{formatRupees(packet.recommendation.estimate.expectedNetPaise)}</strong>
        </p>
        {packet.reasoningMode === "DETERMINISTIC_FALLBACK" && (
          <p className="muted" style={{ fontSize: 13 }}>
            The model did not return a usable answer, so the system selected the highest
            expected net deterministically and labelled it rather than stalling.
          </p>
        )}
        <div className="prose" style={{ marginTop: 10 }}>{packet.recommendation.rationale}</div>

        {packet.recommendation.risksIdentified.length > 0 && (
          <>
            <label>Risks identified</label>
            <ul className="risks">
              {packet.recommendation.risksIdentified.map((risk) => <li key={risk}>{risk}</li>)}
            </ul>
          </>
        )}
        {packet.recommendation.confidenceNote && (
          <>
            <label>Confidence note</label>
            <div className="prose">{packet.recommendation.confidenceNote}</div>
          </>
        )}
      </div>

      {/* 3. Alternatives */}
      <div className="card">
        <h2>Alternatives considered</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          All figures come from the deterministic estimator. The model ranked these; it
          computed none of them.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Playbook</th><th className="num">Recovery</th><th className="num">Gross</th>
                <th className="num">Cost</th><th className="num">Expected net</th>
                <th>Confidence</th><th />
              </tr>
            </thead>
            <tbody>
              {packet.alternatives.map((alternative) => (
                <tr key={alternative.estimateId} className={alternative.isSelected ? "selected" : ""}>
                  <td>{alternative.playbookName}</td>
                  <td className="num">{formatPercent(alternative.pRecoverAvgBps)}</td>
                  <td className="num">{formatRupees(alternative.expectedGrossPaise)}</td>
                  <td className="num">{formatRupees(alternative.costPaise)}</td>
                  <td className="num"><strong>{formatRupees(alternative.expectedNetPaise)}</strong></td>
                  <td><span className="pill pill-muted">{alternative.confidence}</span></td>
                  <td>{alternative.isSelected && <span className="pill pill-accent">selected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4. Guardrails */}
      {[preApproval, preExecution].filter(Boolean).map((evaluation) => (
        <div className="card" key={evaluation!.id}>
          <h2>
            Guardrails — {evaluation!.phase.replace("_", " ").toLowerCase()}
            <span className={decisionPill(evaluation!.decision)}>{evaluation!.decision}</span>
            <span className="mono">policy v{evaluation!.policyVersion}</span>
          </h2>
          <div className="table-scroll">
            <table data-testid={`guardrail-table-${evaluation!.phase}`}>
              <thead>
                <tr><th>Rule</th><th>Observed</th><th>Limit</th><th>Result</th><th>Explanation</th></tr>
              </thead>
              <tbody>
                {evaluation!.results.map((result) => (
                  <tr key={result.ruleId}>
                    <td>{result.label}<div className="mono">{result.ruleId}</div></td>
                    <td className="mono">{result.observed}</td>
                    <td className="mono">{result.limit}</td>
                    <td>
                      <span className={result.passed ? "pill pill-pass" : decisionPill(result.severity)}>
                        {result.passed ? "PASS" : result.severity}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>{result.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* 5. Customer message */}
      <div className="card">
        <h2>Customer message</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Text only. Financial parameters cannot be edited here — they come from the
          estimator and would invalidate the guardrail evaluation.
        </p>
        <label htmlFor="subject">Subject</label>
        <input
          id="subject" type="text" value={subject} data-testid="message-subject"
          disabled={!decidable} onChange={(event) => setSubject(event.target.value)}
        />
        <label htmlFor="body">Body</label>
        <textarea
          id="body" rows={9} value={body} data-testid="message-body"
          disabled={!decidable} onChange={(event) => setBody(event.target.value)}
        />
        {edited && <p className="muted" style={{ fontSize: 12 }}>Edited — your version will be stored with the approval.</p>}

        {/* 6. Approval controls */}
        {decidable ? (
          <div className="actions">
            <button className="danger" disabled={busy} data-testid="reject-button"
              onClick={() => decide("reject")}>Reject</button>
            <button className="primary" disabled={busy} data-testid="approve-button"
              onClick={() => decide("approve")}>
              {busy ? "Checking guardrails…" : "Approve"}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 16 }} data-testid="not-decidable">
            This intervention is {packet.state} and can no longer be decided.
            {packet.approval && ` ${packet.approval.decision} by ${packet.approval.approver}.`}
          </p>
        )}
      </div>

      {/* Execution */}
      {(executable || hasExecuted) && (
        <div className="card" data-testid="execution-card">
          <h2>
            Execution
            <span className={hasExecuted ? "pill pill-pass" : "pill pill-warn"}>
              {hasExecuted ? "EXECUTED" : "READY TO EXECUTE"}
            </span>
          </h2>

          {!hasExecuted && (
            <>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                Approved by {packet.approval?.approver ?? "an approver"}. The executor will
                re-run the pre-execution guardrails against current state before creating
                anything in Razorpay Test Mode.
              </p>
              <div className="actions">
                <button className="accent" onClick={execute} disabled={busy} data-testid="execute-button">
                  {busy ? "Executing…" : "Execute"}
                </button>
              </div>
            </>
          )}

          {hasExecuted && (
            <>
              <div className="banner banner-ok" style={{ marginTop: 4 }}>
                <strong>Payment link created — revenue has NOT yet been recovered.</strong>
                Status is <em>awaiting payment</em>. Attribution arrives in the next phase,
                when a real payment event confirms it.
              </div>
              <div className="table-scroll">
                <table data-testid="artifact-table">
                  <thead>
                    <tr>
                      <th>Razorpay Test Payment Link</th><th className="num">Amount</th>
                      <th>Status</th><th>Provider id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packet.execution.artifacts.slice(0, 10).map((artifact) => (
                      <tr key={artifact.id}>
                        <td>
                          <a href={artifact.shortUrl} target="_blank" rel="noreferrer noopener"
                             data-testid="payment-link">{artifact.shortUrl}</a>
                        </td>
                        <td className="num">{formatRupees(artifact.amountPaise)}</td>
                        <td><span className="pill pill-warn">awaiting payment</span></td>
                        <td className="mono">{artifact.providerEntityId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {packet.execution.artifacts.length > 10 && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Showing 10 of {packet.execution.artifacts.length} links · total{" "}
                  {formatRupees(packet.execution.totalAmountPaise)} awaiting payment.
                </p>
              )}
            </>
          )}

          {packet.execution.attempts.length > 0 && (
            <>
              <label>Execution attempts</label>
              <ul className="timeline">
                {packet.execution.attempts.slice(0, 6).map((attempt) => (
                  <li key={attempt.attemptNo}>
                    <span className="seq">#{attempt.attemptNo}</span>
                    <span className={attempt.status === "SUCCEEDED" ? "pill pill-pass" : "pill pill-block"}>
                      {attempt.status}
                    </span>
                    <span className="mono">key {attempt.idempotencyKey}</span>
                    {attempt.error && <span className="muted">{attempt.error.slice(0, 60)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* Attribution — realised revenue, or an explanation of its absence */}
      {(converted || awaitingPayment) && (
        <div className="card" data-testid="attribution-card">
          <h2>
            Attribution
            <span className={converted ? "pill pill-pass" : "pill pill-warn"}>
              {converted ? "CONVERTED" : "AWAITING PAYMENT"}
            </span>
          </h2>

          {converted ? (
            <>
              <div className="row" style={{ gap: 32, marginBottom: 8 }}>
                <div>
                  <div className="label">Actual recovered revenue</div>
                  <div style={{ fontSize: 26, fontWeight: 650 }} data-testid="recovered-amount">
                    {formatRupees(packet.attribution.recoveredAmountPaise)}
                  </div>
                  {/* Realised, not projected. */}
                  <div className="muted" style={{ fontSize: 12 }}>
                    Confirmed by a verified payment event
                  </div>
                </div>
                <div>
                  <div className="label">Expected net (estimate)</div>
                  <div style={{ fontSize: 26, fontWeight: 650, color: "var(--muted)" }}>
                    {formatRupees(packet.recommendation.estimate.expectedNetPaise)}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    What the estimator projected, unchanged
                  </div>
                </div>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Method</th><th>Confidence</th><th className="num">Amount</th>
                      <th>Payment event</th><th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packet.attribution.records.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <span className="pill pill-accent" data-testid="attribution-method">
                            {record.method}
                          </span>
                        </td>
                        <td><span className="pill pill-pass">{record.confidence}</span></td>
                        <td className="num">{formatRupees(record.attributedAmountPaise)}</td>
                        <td className="mono">
                          {record.providerEventId ?? "—"}
                          {record.simulated && (
                            <span className="pill pill-warn" style={{ marginLeft: 6 }}>simulated</span>
                          )}
                        </td>
                        <td className="mono">{formatDateTime(record.attributedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {packet.attribution.records[0]?.note && (
                <p className="muted" style={{ fontSize: 13 }}>
                  {packet.attribution.records[0].note}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 14, marginTop: 0 }}>
                The payment link exists and is awaiting payment. Nothing is counted as
                recovered until a verified payment event arrives and attribution resolves.
                If the evidence is ambiguous the system will refuse to claim credit rather
                than guess.
              </p>
              <div className="actions">
                <button
                  onClick={() => simulate(packet.execution.artifacts[0]!.id)}
                  disabled={busy}
                  data-testid="simulate-payment"
                >
                  {busy ? "Delivering event…" : "Simulate payment (demo)"}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>
                The simulation builds a signed provider event and pushes it through the same
                webhook pipeline — it cannot mark this converted by itself.
              </p>
            </>
          )}
        </div>
      )}

      {/* 7. Audit timeline */}
      <div className="card">
        <h2>Audit timeline</h2>
        <ul className="timeline" data-testid="audit-timeline">
          {packet.auditTimeline.map((entry) => (
            <li key={entry.seq}>
              <span className="seq">#{entry.seq}</span>
              <span className="pill pill-muted">{entry.actorType}</span>
              <span>{entry.action.replaceAll("_", " ").toLowerCase()}</span>
              <span className="when">{formatDateTime(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
        {packet.reasoning.length > 0 && (
          <>
            <label>Model attempts</label>
            <ul className="timeline">
              {packet.reasoning.map((call) => (
                <li key={call.id}>
                  <span className="seq">#{call.attemptNo}</span>
                  <span className={call.isValid ? "pill pill-pass" : "pill pill-block"}>{call.outcome}</span>
                  <span className="mono">{call.provider}/{call.model}</span>
                  <span className="when">{call.latencyMs}ms</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
