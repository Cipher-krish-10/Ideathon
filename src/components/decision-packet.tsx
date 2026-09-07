"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CreditCard,
  ExternalLink, Link2, ShieldCheck, TrendingUp, XCircle,
} from "lucide-react";

import { GuardrailPanel } from "@/components/decision-packet/guardrail-panel";
import { StrategyCards } from "@/components/decision-packet/strategy-cards";
import { Counter } from "@/components/ui/counter";
import { PageHeader, TopBar } from "@/components/layout/topbar";
import { decisionPill, formatDateTime, formatPercent, formatRupees } from "@/lib/format";

/**
 * The decision packet.
 *
 * A financial authorization workspace: everything a merchant needs to approve
 * a money action, in the order they need it.
 *
 *   evidence  →  recommendation  →  comparison  →  controls  →  authorize
 *
 * The layout deliberately separates what was OBSERVED from what is MODELLED
 * from what has HAPPENED. Those three are never adjacent without a label
 * saying which is which, because conflating them is how a demo overstates
 * itself. No raw database JSON is shown anywhere.
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
  // guardrails against current state. EXECUTION_FAILED is retryable.
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
  const failureReasons = Object.entries(packet.opportunity.failureReasonBreakdown)
    .sort((a, b) => b[1] - a[1]);
  const totalFailures = failureReasons.reduce((sum, [, count]) => sum + count, 0);

  return (
    <>
      <TopBar
        crumbs={[
          { label: "Nimbus Commerce", href: "/" },
          { label: "Interventions", href: "/interventions" },
          { label: "Decision packet" },
        ]}
        agentStatus="ACTIVE"
        showRunAgent={false}
      />

      <div className="content">
        <Link href="/interventions" className="row-link" style={{ marginBottom: 12 }}>
          <ArrowLeft size={12} />Back to interventions
        </Link>

        <PageHeader
          title="Decision Packet"
          subtitle={`Failed payment recovery · ${packet.targetCount} customers · ${formatRupees(packet.opportunity.recoverableAmountPaise)} at risk`}
          actions={
            <span className={decisionPill(packet.state)}>
              {packet.state.replaceAll("_", " ")}
            </span>
          }
        />

        {/* ------------------------------------------------------- outcome */}
        <AnimatePresence>
          {outcome?.kind === "blocked" && (
            <motion.div
              className="banner banner-block" data-testid="blocked-banner"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            >
              <XCircle size={16} />
              <span>
                <strong>Action blocked</strong>
                {outcome.rules.map((rule) => (
                  <div key={rule.ruleId}>
                    <span className="mono" data-testid="blocking-rule">{rule.ruleId}</span> — {rule.message}
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>Nothing was sent and no money moved.</div>
              </span>
            </motion.div>
          )}
          {outcome?.kind === "approved" && (
            <motion.div
              className="banner banner-ok" data-testid="approved-banner"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            >
              <CheckCircle2 size={16} />
              <span>
                <strong>Approved</strong>
                Merchant authorization recorded. No money has moved — execution is a separate step.
              </span>
            </motion.div>
          )}
          {outcome?.kind === "executed" && (
            <motion.div
              className="banner banner-ok" data-testid="executed-banner"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            >
              <CreditCard size={16} />
              <span>
                <strong>Executed — {outcome.count} payment link(s) created in Razorpay Test Mode</strong>
                Payment link created — revenue has <strong style={{ display: "inline" }}>NOT</strong> yet
                been recovered. The links are awaiting payment.
              </span>
            </motion.div>
          )}
          {outcome?.kind === "executionFailed" && (
            <div className="banner banner-block" data-testid="execution-failed-banner">
              <AlertTriangle size={16} />
              <span>
                <strong>RevenuePilot could not safely complete the action</strong>
                {outcome.message}
                <div style={{ marginTop: 6 }}>No payment link was created. You can retry.</div>
              </span>
            </div>
          )}
          {outcome?.kind === "rejected" && (
            <div className="banner banner-block" data-testid="rejected-banner">
              <XCircle size={16} /><span><strong>Rejected</strong>This proposal is closed.</span>
            </div>
          )}
          {outcome?.kind === "error" && (
            <div className="banner banner-block" data-testid="error-banner">
              <AlertTriangle size={16} /><span><strong>Could not complete</strong>{outcome.message}</span>
            </div>
          )}
        </AnimatePresence>

        {/* ============================ evidence  |  recommendation ======== */}
        <div className="grid" style={{ alignItems: "start" }}>
          {/* --------------------------------------------------- evidence */}
          <div className="col-5">
            <div className="panel">
              <div className="panel-head">
                <h2>Opportunity evidence</h2>
                <span className="spacer" />
                <span className="mono">{packet.opportunity.detectorVersion}</span>
              </div>

              <div className="panel-body">
                <div className="row" style={{ gap: 32, alignItems: "flex-start" }}>
                  <div>
                    <div className="m-label">At risk<span className="m-tag">Potential</span></div>
                    <div className="m-value" style={{ fontSize: 26 }} data-testid="recoverable-amount">
                      {formatRupees(packet.opportunity.recoverableAmountPaise)}
                    </div>
                    <div className="m-note">{packet.opportunity.affectedCustomerCount} customers</div>
                  </div>
                  <div>
                    <div className="m-label">Expected net<span className="m-tag">Est</span></div>
                    <div className="m-value" style={{ fontSize: 26 }}>
                      {formatRupees(selected.expectedNetPaise)}
                    </div>
                    <div className="m-note">{selected.confidence.toLowerCase()} confidence</div>
                  </div>
                </div>
              </div>

              {/* Failure distribution: the actual reason each payment failed,
                  counted by the detector. This is the evidence the whole
                  recommendation rests on, so it gets real space. */}
              <div className="panel-head" style={{ borderTop: "1px solid var(--line)" }}>
                <h2>Failure distribution</h2>
                <span className="spacer" />
                <span className="mono">{totalFailures} attempts</span>
              </div>
              <div className="panel-body" style={{ paddingTop: 4 }}>
                {failureReasons.map(([reason, count]) => (
                  <div className="funnel-row" key={reason} style={{ padding: "5px 0" }}>
                    <span
                      className="funnel-label"
                      style={{ width: 150, fontSize: 12, fontWeight: 450 }}
                    >
                      {reason.toLowerCase().replaceAll("_", " ")}
                    </span>
                    <span className="funnel-track" style={{ height: 16 }}>
                      <span
                        className="funnel-fill"
                        style={{
                          width: `${Math.max((count / totalFailures) * 100, 3)}%`,
                          background: "var(--ink-200)",
                        }}
                      />
                    </span>
                    <span className="mono" style={{ width: 26, textAlign: "right" }}>{count}</span>
                  </div>
                ))}
              </div>

              <div className="panel-foot">
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Counted from the merchant&apos;s payment history by the detector. No model
                  was involved in producing these figures.
                </span>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------ AI decision */}
          <div className="col-7">
            <div className="panel">
              <div className="panel-head">
                <h2>Recommendation</h2>
                <span className="spacer" />
                <span className={packet.reasoningMode === "LLM" ? "badge badge-ai" : "badge badge-neutral"}>
                  {packet.reasoningMode}
                </span>
              </div>

              <div className="panel-body">
                {packet.reasoningMode === "DETERMINISTIC_FALLBACK" && (
                  <div className="banner banner-info">
                    <AlertTriangle size={15} />
                    <span>
                      The model did not return a usable answer, so the system selected the
                      highest expected net deterministically and labelled it rather than stalling.
                    </span>
                  </div>
                )}

                {/* The action, stated plainly before any prose. */}
                <div
                  className="row"
                  style={{
                    gap: 10, paddingBottom: 14, marginBottom: 14,
                    borderBottom: "1px solid var(--line)", flexWrap: "nowrap",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="m-label">Recommended action</div>
                    <strong
                      data-testid="selected-playbook"
                      style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.018em" }}
                    >
                      {packet.recommendation.playbookName}
                    </strong>
                    <span className="mono" style={{ display: "block" }}>
                      {packet.recommendation.playbookKey}
                    </span>
                  </div>
                  <span className="spacer" />
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div className="m-label" style={{ justifyContent: "flex-end" }}>Recovery rate</div>
                    <div style={{ fontSize: 16, fontWeight: 580 }}>
                      {formatPercent(selected.pRecoverAvgBps)}
                    </div>
                  </div>
                </div>

                <div className="m-label" style={{ marginBottom: 5 }}>Why this action</div>
                <div className="prose">{packet.recommendation.rationale}</div>

                {packet.recommendation.risksIdentified.length > 0 && (
                  <>
                    <label>Risks</label>
                    <ul className="risks">
                      {packet.recommendation.risksIdentified.map((risk) => <li key={risk}>{risk}</li>)}
                    </ul>
                  </>
                )}
                {packet.recommendation.confidenceNote && (
                  <>
                    <label>Confidence</label>
                    <div className="prose" style={{ fontSize: 13 }}>
                      {packet.recommendation.confidenceNote}
                    </div>
                  </>
                )}
              </div>

              <div className="panel-foot">
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {/* Only claim the model did something when it actually did.
                      Under DETERMINISTIC_FALLBACK no model contributed, and
                      saying otherwise would misattribute the decision. */}
                  {packet.reasoningMode === "LLM"
                    ? "The model ranked pre-scored candidates and wrote this explanation. It did not compute any figure on this page."
                    : "No model contributed to this proposal. The system selected the highest expected net deterministically."}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ============================================ strategy comparison */}
        <div className="panel">
          <div className="panel-head">
            <h2>Alternatives considered</h2>
            <span className="spacer" />
            <span className="mono">{selected.estimatorVersion}</span>
          </div>
          <StrategyCards strategies={packet.alternatives} />
          <div className="panel-foot">
            <span className="muted" style={{ fontSize: 11.5 }}>
              Every figure comes from the deterministic estimator. The model ranked these;
              it computed none of them.
            </span>
          </div>
        </div>

        {/* ==================================================== guardrails */}
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

        {/* ===================================================== authorize */}
        <div className="panel">
          <div className="panel-head">
            <h2>{decidable ? "Authorize action" : "Customer message"}</h2>
            <span className="spacer" />
            {decidable && <span className="badge badge-warn">Awaiting your decision</span>}
          </div>

          {decidable && (
            <>
              {/* What is actually being authorised, restated compactly right
                  above the button that authorises it. */}
              <div className="metric-strip" style={{ border: 0, borderRadius: 0,
                                                     borderBottom: "1px solid var(--line)" }}>
                <div className="metric">
                  <div className="m-label">Strategy</div>
                  <div className="m-value" style={{ fontSize: 14 }}>
                    {packet.recommendation.playbookName}
                  </div>
                </div>
                <div className="metric">
                  <div className="m-label">Maximum exposure</div>
                  <div className="m-value" style={{ fontSize: 14 }}>
                    {formatRupees(selected.expectedGrossPaise)}
                  </div>
                </div>
                <div className="metric">
                  <div className="m-label">Expected net</div>
                  <div className="m-value" style={{ fontSize: 14 }}>
                    {formatRupees(selected.expectedNetPaise)}
                  </div>
                </div>
                <div className="metric">
                  <div className="m-label">Customers</div>
                  <div className="m-value" style={{ fontSize: 14 }}>{packet.targetCount}</div>
                </div>
              </div>
            </>
          )}

          <div className="panel-body">
            <p className="panel-note">
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
              id="body" rows={7} value={body} data-testid="message-body"
              disabled={!decidable} onChange={(event) => setBody(event.target.value)}
            />
            {edited && (
              <p className="field-hint">Edited — your version will be stored with the approval.</p>
            )}

            {!decidable && (
              <p className="muted" style={{ marginTop: 14, fontSize: 13 }} data-testid="not-decidable">
                This intervention is {packet.state} and can no longer be decided.
                {packet.approval && ` ${packet.approval.decision} by ${packet.approval.approver}.`}
              </p>
            )}
          </div>

          {decidable && (
            <div className="panel-foot">
              <span className="muted" style={{ fontSize: 11.5 }}>
                Approving records your authorization. It does not move money.
              </span>
              <span className="spacer" />
              <button className="danger" disabled={busy} data-testid="reject-button"
                      onClick={() => decide("reject")}>
                <XCircle size={14} />Reject
              </button>
              <button className="approve" disabled={busy} data-testid="approve-button"
                      onClick={() => decide("approve")}>
                <ShieldCheck size={15} />
                {busy ? "Checking guardrails…" : "Approve action"}
              </button>
            </div>
          )}
        </div>

        {/* ===================================================== execution */}
        {(executable || hasExecuted) && (
          <div className="panel" data-testid="execution-card">
            <div className="panel-head">
              <h2>Payment action</h2>
              <span className="badge badge-warn"><CreditCard />Razorpay Test Mode</span>
              <span className="spacer" />
              <span className={hasExecuted ? "badge badge-ok" : "badge badge-warn"}>
                {hasExecuted ? "EXECUTED" : "READY TO EXECUTE"}
              </span>
            </div>

            {!hasExecuted ? (
              <>
                <div className="panel-body">
                  <p className="panel-note" style={{ margin: 0 }}>
                    Approved by {packet.approval?.approver ?? "an approver"}. The executor
                    re-runs the pre-execution guardrails against current state before creating
                    anything in Razorpay.
                  </p>
                </div>
                <div className="panel-foot">
                  <span className="spacer" />
                  <button className="primary" onClick={execute} disabled={busy}
                          data-testid="execute-button">
                    <ArrowRight size={14} />{busy ? "Executing…" : "Execute action"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="panel-body" style={{ paddingBottom: 0 }}>
                  <div className="banner banner-ok">
                    <Link2 size={15} />
                    <span>
                      <strong>Payment link created — revenue has NOT yet been recovered.</strong>
                      Status is <em>awaiting payment</em>. Attribution follows a verified payment event.
                    </span>
                  </div>
                </div>
                <div className="table-wrap">
                  <table data-testid="artifact-table">
                    <thead>
                      <tr>
                        <th>Razorpay test payment link</th>
                        <th className="num">Amount</th>
                        <th>Status</th>
                        <th>Provider id</th>
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
                          <td className="num money">{formatRupees(artifact.amountPaise)}</td>
                          <td><span className="badge badge-warn">awaiting payment</span></td>
                          <td className="mono">{artifact.providerEntityId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="panel-foot">
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {packet.execution.artifacts.length > 8
                      ? `Showing 8 of ${packet.execution.artifacts.length} links · ${formatRupees(packet.execution.totalAmountPaise)} awaiting payment.`
                      : `${formatRupees(packet.execution.totalAmountPaise)} awaiting payment.`}
                  </span>
                  {packet.execution.attempts.length > 0 && (
                    <>
                      <span className="spacer" />
                      {packet.execution.attempts.slice(0, 4).map((attempt) => (
                        <span key={attempt.attemptNo}
                              className={attempt.status === "SUCCEEDED" ? "badge badge-ok" : "badge badge-stop"}>
                          #{attempt.attemptNo} {attempt.status} · {attempt.idempotencyKey}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* =================================================== attribution */}
        {(converted || awaitingPayment) && (
          <div className="panel" data-testid="attribution-card">
            <div className="panel-head">
              <h2>Attribution</h2>
              <span className="spacer" />
              <span className={converted ? "badge badge-ok" : "badge badge-warn"}>
                {converted ? "CONVERTED" : "AWAITING PAYMENT"}
              </span>
            </div>

            {converted ? (
              <>
                {/*
                 * The recovery moment. One large figure, clearly labelled as
                 * the only ACTUAL number in the product, beside the estimate
                 * it can be compared against. No confetti — this is money
                 * arriving, and the restraint is the point.
                 */}
                <div className="metric-strip" style={{ border: 0, borderRadius: 0,
                                                       borderBottom: "1px solid var(--line)" }}>
                  <div className="metric lead is-actual">
                    <div className="m-label">
                      Actual recovered revenue<span className="m-tag actual">Actual</span>
                    </div>
                    <Counter className="m-value" value={packet.attribution.recoveredAmountPaise}
                             testId="recovered-amount" />
                    <div className="m-note">Confirmed by a verified payment event</div>
                  </div>
                  <div className="metric is-estimate">
                    <div className="m-label">Expected net<span className="m-tag">Est</span></div>
                    <div className="m-value" style={{ color: "var(--ink-400)" }}>
                      {formatRupees(selected.expectedNetPaise)}
                    </div>
                    <div className="m-note">What the estimator projected, unchanged</div>
                  </div>
                </div>

                <div className="table-wrap">
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
                          <td className="num money">{formatRupees(record.attributedAmountPaise)}</td>
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
                <div className="panel-body">
                  <p className="panel-note" style={{ margin: 0 }}>
                    The payment link exists and is awaiting payment. Nothing is counted as
                    recovered until a verified payment event arrives and attribution resolves.
                    If the evidence is ambiguous, RevenuePilot refuses to claim the revenue
                    rather than guessing.
                  </p>
                </div>
                <div className="panel-foot">
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    The simulation builds a signed provider event and pushes it through the same
                    webhook receiver a real payment hits.
                  </span>
                  <span className="spacer" />
                  <button onClick={() => simulate(packet.execution.artifacts[0]!.id)}
                          disabled={busy} data-testid="simulate-payment">
                    <TrendingUp size={14} />
                    {busy ? "Delivering event…" : "Simulate payment (demo)"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ====================================================== timeline */}
        <div className="panel">
          <div className="panel-head">
            <h2>Audit trail</h2>
            <span className="spacer" />
            <span className="mono">{packet.auditTimeline.length} events</span>
          </div>
          <ul className="timeline" data-testid="audit-timeline">
            {packet.auditTimeline.map((entry) => (
              <li key={entry.seq}>
                <span className="tl-time">#{entry.seq}</span>
                <span className="tl-body">
                  <span className="tl-label">{entry.action.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="tl-detail">
                    {entry.actorType} · {formatDateTime(entry.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {packet.reasoning.length > 0 && (
            <div className="panel-foot">
              <span className="muted" style={{ fontSize: 11.5 }}>Model attempts</span>
              <span className="spacer" />
              {packet.reasoning.map((call) => (
                <span key={call.id}
                      className={call.isValid ? "badge badge-ok" : "badge badge-stop"}>
                  #{call.attemptNo} {call.outcome} · {call.model} · {call.latencyMs}ms
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
