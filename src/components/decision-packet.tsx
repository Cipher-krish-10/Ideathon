"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, ArrowRight, Brain, CheckCircle2, CreditCard,
  ExternalLink, Link2, ShieldCheck, Sparkles, TrendingUp, XCircle,
} from "lucide-react";

import { GuardrailPanel } from "@/components/decision-packet/guardrail-panel";
import { StrategyCards } from "@/components/decision-packet/strategy-cards";
import { Counter } from "@/components/ui/counter";
import { TopBar } from "@/components/layout/topbar";
import { decisionPill, formatDateTime, formatRupees } from "@/lib/format";

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
  pRecoverAvgBps: number; confidence: string; discountBps: number;
  estimatorVersion: string; isSelected?: boolean;
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
  const selected = packet.recommendation.estimate;

  return (
    <>
      <TopBar
        title="Decision Packet"
        subtitle={`${packet.targetCount} customers · ${packet.state.replaceAll("_", " ").toLowerCase()}`}
        agentStatus="ACTIVE"
        showRunAgent={false}
      />

      <div className="content">
        {/* ------------------------------------------------------- outcome */}
        <AnimatePresence>
          {outcome?.kind === "blocked" && (
            <motion.div
              className="banner banner-block" data-testid="blocked-banner"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            >
              <XCircle size={17} />
              <span>
                <strong>Action blocked</strong>
                {outcome.rules.map((rule) => (
                  <div key={rule.ruleId}>
                    <span className="mono" data-testid="blocking-rule">{rule.ruleId}</span> — {rule.message}
                  </div>
                ))}
                <div style={{ marginTop: 7 }}>Nothing was sent and no money moved.</div>
              </span>
            </motion.div>
          )}
          {outcome?.kind === "approved" && (
            <motion.div
              className="banner banner-ok" data-testid="approved-banner"
              initial={{ opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }}
            >
              <CheckCircle2 size={17} />
              <span>
                <strong>Approved</strong>
                Recorded against your account. No money has moved — execution is the next step.
              </span>
            </motion.div>
          )}
          {outcome?.kind === "executed" && (
            <motion.div
              className="banner banner-ok" data-testid="executed-banner"
              initial={{ opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }}
            >
              <CreditCard size={17} />
              <span>
                <strong>Executed — {outcome.count} payment link(s) created in Razorpay Test Mode</strong>
                Payment link created — revenue has <strong style={{ display: "inline" }}>NOT</strong> yet
                been recovered. The links are awaiting payment.
              </span>
            </motion.div>
          )}
          {outcome?.kind === "executionFailed" && (
            <div className="banner banner-block" data-testid="execution-failed-banner">
              <AlertTriangle size={17} />
              <span>
                <strong>RevenuePilot could not safely complete the action</strong>
                {outcome.message}
                <div style={{ marginTop: 7 }}>No payment link was created. You can retry.</div>
              </span>
            </div>
          )}
          {outcome?.kind === "rejected" && (
            <div className="banner banner-block" data-testid="rejected-banner">
              <XCircle size={17} /><span><strong>Rejected</strong>This proposal is closed.</span>
            </div>
          )}
          {outcome?.kind === "error" && (
            <div className="banner banner-block" data-testid="error-banner">
              <AlertTriangle size={17} /><span><strong>Could not complete</strong>{outcome.message}</span>
            </div>
          )}
        </AnimatePresence>

        {/* --------------------------------------- summary + AI reasoning */}
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="card">
            <div className="card-head">
              <h2>Decision summary</h2>
              <span className="spacer" />
              <span className={decisionPill(packet.state)}>{packet.state}</span>
            </div>

            <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="kpi kpi-historical" style={{ boxShadow: "none" }}>
                <div className="label">At risk</div>
                <div className="value" style={{ fontSize: 22 }} data-testid="recoverable-amount">
                  {formatRupees(packet.opportunity.recoverableAmountPaise)}
                </div>
                <div className="note">{packet.opportunity.affectedCustomerCount} customers</div>
              </div>
              <div className="kpi kpi-projected" style={{ boxShadow: "none" }}>
                <div className="label">Expected net</div>
                <div className="value" style={{ fontSize: 22 }}>
                  {formatRupees(selected.expectedNetPaise)}
                </div>
                <div className="note">Estimate · {selected.confidence} confidence</div>
              </div>
            </div>

            <label>Failure reasons in this cohort</label>
            <div className="row" style={{ gap: 6 }}>
              {Object.entries(packet.opportunity.failureReasonBreakdown).map(([reason, count]) => (
                <span key={reason} className="badge badge-neutral">
                  {reason.toLowerCase().replaceAll("_", " ")} · {count}
                </span>
              ))}
            </div>

            <label>Recommended action</label>
            <div className="row" style={{ gap: 8 }}>
              <strong data-testid="selected-playbook" style={{ fontSize: 15 }}>
                {packet.recommendation.playbookName}
              </strong>
              <span className="mono">{packet.recommendation.playbookKey}</span>
            </div>
          </div>

          <div className="card card-ai">
            <div className="card-head">
              <span className="badge badge-ai"><Brain />AI recommendation</span>
              <span className="spacer" />
              <span className="badge badge-neutral">{packet.reasoningMode}</span>
            </div>

            {packet.reasoningMode === "DETERMINISTIC_FALLBACK" && (
              <div className="banner banner-info" style={{ marginBottom: 14 }}>
                <AlertTriangle size={15} />
                <span>
                  The model did not return a usable answer, so the system selected the highest
                  expected net deterministically and labelled it rather than stalling.
                </span>
              </div>
            )}

            <div className="prose">{packet.recommendation.rationale}</div>

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
                <div className="prose" style={{ fontSize: 13.5 }}>{packet.recommendation.confidenceNote}</div>
              </>
            )}
          </div>
        </div>

        {/* -------------------------------------------------- alternatives */}
        <div className="card">
          <div className="card-head">
            <h2>Alternatives considered</h2>
            <span className="spacer" />
            <span className="mono">{selected.estimatorVersion}</span>
          </div>
          <p className="card-note">
            Every figure comes from the deterministic estimator. The model ranked these; it
            computed none of them.
          </p>
          <StrategyCards strategies={packet.alternatives} />
        </div>

        {/* ---------------------------------------------------- guardrails */}
        {preApproval && (
          <GuardrailPanel
            phase={preApproval.phase} decision={preApproval.decision}
            policyVersion={preApproval.policyVersion} results={preApproval.results}
          />
        )}
        {preExecution && (
          <GuardrailPanel
            phase={preExecution.phase} decision={preExecution.decision}
            policyVersion={preExecution.policyVersion} results={preExecution.results}
          />
        )}

        {/* ----------------------------------------------------- approval */}
        <div className="card">
          <div className="card-head">
            <h2>{decidable ? "Ready for approval" : "Customer message"}</h2>
            <span className="spacer" />
            {decidable && <span className="badge badge-warn">Awaiting your decision</span>}
          </div>
          <p className="card-note">
            Text only. Financial parameters cannot be edited here — they come from the
            estimator, and changing them would invalidate the guardrail evaluation.
          </p>

          <label htmlFor="subject">Subject</label>
          <input
            id="subject" type="text" value={subject} data-testid="message-subject"
            disabled={!decidable} onChange={(event) => setSubject(event.target.value)}
          />
          <label htmlFor="body">Body</label>
          <textarea
            id="body" rows={8} value={body} data-testid="message-body"
            disabled={!decidable} onChange={(event) => setBody(event.target.value)}
          />
          {edited && (
            <p className="muted" style={{ fontSize: 12 }}>
              Edited — your version will be stored with the approval.
            </p>
          )}

          {decidable ? (
            <div className="actions">
              <button className="danger" disabled={busy} data-testid="reject-button"
                onClick={() => decide("reject")}>
                <XCircle size={15} />Reject
              </button>
              <button className="approve" disabled={busy} data-testid="approve-button"
                onClick={() => decide("approve")}>
                <ShieldCheck size={16} />
                {busy ? "Checking guardrails…" : "Approve & continue"}
              </button>
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 16 }} data-testid="not-decidable">
              This intervention is {packet.state} and can no longer be decided.
              {packet.approval && ` ${packet.approval.decision} by ${packet.approval.approver}.`}
            </p>
          )}
        </div>

        {/* ---------------------------------------------------- execution */}
        {(executable || hasExecuted) && (
          <div className="card" data-testid="execution-card">
            <div className="card-head">
              <h2>Payment action</h2>
              <span className="badge badge-warn"><CreditCard />Razorpay Test Mode</span>
              <span className="spacer" />
              <span className={hasExecuted ? "badge badge-ok" : "badge badge-warn"}>
                {hasExecuted ? "EXECUTED" : "READY TO EXECUTE"}
              </span>
            </div>

            {!hasExecuted ? (
              <>
                <p className="card-note">
                  Approved by {packet.approval?.approver ?? "an approver"}. The executor
                  re-runs the pre-execution guardrails against current state before creating
                  anything in Razorpay.
                </p>
                <div className="actions">
                  <button className="primary" onClick={execute} disabled={busy} data-testid="execute-button">
                    <ArrowRight size={15} />{busy ? "Executing…" : "Execute action"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="banner banner-ok">
                  <Link2 size={16} />
                  <span>
                    <strong>Payment link created — revenue has NOT yet been recovered.</strong>
                    Status is <em>awaiting payment</em>. Attribution follows a verified payment event.
                  </span>
                </div>
                <div className="table-scroll">
                  <table data-testid="artifact-table">
                    <thead>
                      <tr>
                        <th>Razorpay Test payment link</th><th className="num">Amount</th>
                        <th>Status</th><th>Provider id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packet.execution.artifacts.slice(0, 8).map((artifact) => (
                        <tr key={artifact.id}>
                          <td>
                            <a href={artifact.shortUrl} target="_blank" rel="noreferrer noopener"
                               data-testid="payment-link" className="row" style={{ gap: 5 }}>
                              {artifact.shortUrl}<ExternalLink size={12} />
                            </a>
                          </td>
                          <td className="num">{formatRupees(artifact.amountPaise)}</td>
                          <td><span className="badge badge-warn">awaiting payment</span></td>
                          <td className="mono">{artifact.providerEntityId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {packet.execution.artifacts.length > 8 && (
                  <p className="muted" style={{ fontSize: 12 }}>
                    Showing 8 of {packet.execution.artifacts.length} links ·{" "}
                    {formatRupees(packet.execution.totalAmountPaise)} awaiting payment.
                  </p>
                )}
                {packet.execution.attempts.length > 0 && (
                  <>
                    <label>Execution attempts</label>
                    <div className="row" style={{ gap: 7 }}>
                      {packet.execution.attempts.slice(0, 6).map((attempt) => (
                        <span key={attempt.attemptNo}
                          className={attempt.status === "SUCCEEDED" ? "badge badge-ok" : "badge badge-stop"}>
                          #{attempt.attemptNo} {attempt.status} · key {attempt.idempotencyKey}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* -------------------------------------------------- attribution */}
        {(converted || awaitingPayment) && (
          <div className="card" data-testid="attribution-card">
            <div className="card-head">
              <h2>Attribution</h2>
              <span className="spacer" />
              <span className={converted ? "badge badge-ok" : "badge badge-warn"}>
                {converted ? "CONVERTED" : "AWAITING PAYMENT"}
              </span>
            </div>

            {converted ? (
              <>
                <motion.div
                  className="banner banner-ok"
                  initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                >
                  <CheckCircle2 size={17} />
                  <span><strong>Payment verified</strong>Attribution resolved from a verified payment event.</span>
                </motion.div>

                <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <div className="kpi kpi-actual">
                    <span className="kpi-tag">Actual</span>
                    <div className="label">Actual recovered revenue</div>
                    {/* Realised money, not the projection beside it. */}
                    <Counter
                      className="value hero"
                      value={packet.attribution.recoveredAmountPaise}
                                            testId="recovered-amount"
                    />
                    <div className="note">Confirmed by a verified payment event</div>
                  </div>
                  <div className="kpi kpi-projected">
                    <span className="kpi-tag">Estimate</span>
                    <div className="label">Expected net</div>
                    <div className="value" style={{ color: "var(--ink-400)" }}>
                      {formatRupees(selected.expectedNetPaise)}
                    </div>
                    <div className="note">What the estimator projected, unchanged</div>
                  </div>
                </div>

                <div className="table-scroll" style={{ marginTop: 14 }}>
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
                            <span className="badge badge-blue" data-testid="attribution-method">
                              {record.method}
                            </span>
                          </td>
                          <td><span className="badge badge-ok">{record.confidence}</span></td>
                          <td className="num">{formatRupees(record.attributedAmountPaise)}</td>
                          <td className="mono">
                            {record.providerEventId ?? "—"}
                            {record.simulated && (
                              <span className="badge badge-warn" style={{ marginLeft: 6 }}>simulated</span>
                            )}
                          </td>
                          <td className="mono">{formatDateTime(record.attributedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <p className="card-note">
                  The payment link exists and is awaiting payment. Nothing is counted as
                  recovered until a verified payment event arrives and attribution resolves.
                  If the evidence is ambiguous, RevenuePilot refuses to claim the revenue
                  rather than guessing.
                </p>
                <div className="actions">
                  <button
                    onClick={() => simulate(packet.execution.artifacts[0]!.id)}
                    disabled={busy} data-testid="simulate-payment"
                  >
                    <TrendingUp size={15} />
                    {busy ? "Delivering event…" : "Simulate payment (demo)"}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  The simulation builds a signed provider event and pushes it through the same
                  webhook pipeline — it cannot mark this converted by itself.
                </p>
              </>
            )}
          </div>
        )}

        {/* ----------------------------------------------------- timeline */}
        <div className="card">
          <div className="card-head"><h2>Activity timeline</h2></div>
          <ul className="timeline" data-testid="audit-timeline">
            {packet.auditTimeline.map((entry) => (
              <li key={entry.seq}>
                <span className="tl-icon"><Sparkles strokeWidth={2} /></span>
                <span className="tl-body">
                  <span className="tl-label">{entry.action.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="tl-detail">{entry.actorType} · #{entry.seq}</span>
                </span>
                <span className="tl-time">{formatDateTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
          {packet.reasoning.length > 0 && (
            <>
              <label>Model attempts</label>
              <div className="row" style={{ gap: 7 }}>
                {packet.reasoning.map((call) => (
                  <span key={call.id} className={call.isValid ? "badge badge-ok" : "badge badge-stop"}>
                    #{call.attemptNo} {call.outcome} · {call.provider}/{call.model} · {call.latencyMs}ms
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
