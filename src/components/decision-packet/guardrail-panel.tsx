"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ShieldCheck, XCircle } from "lucide-react";

/**
 * Execution controls.
 *
 * A financial control system, so it reads as one: a verdict at the top, then a
 * dense table of every rule with what was observed and what the limit was.
 * Nothing is hidden behind an accordion by default — an auditor should be able
 * to scan all ten results without a single click — and expanding a row adds
 * the rule's own message.
 *
 * The table is the real, visible table. An earlier version rendered a
 * duplicate, visually-hidden table purely to satisfy the E2E contract while
 * showing something else on screen; a test that asserts against a hidden mirror
 * of the UI is not testing the UI.
 */
export interface RuleResult {
  ruleId: string; label: string; severity: string; passed: boolean;
  observed: string; limit: string; message: string;
}

export function GuardrailPanel({
  phase, decision, policyVersion, results,
}: {
  phase: string; decision: string; policyVersion: number; results: RuleResult[];
}) {
  const [open, setOpen] = useState<string | null>(
    // The failing rule is the one worth reading, so it starts open.
    results.find((rule) => !rule.passed)?.ruleId ?? null,
  );

  const failing = results.filter((rule) => !rule.passed);
  const blocking = failing.filter((rule) => rule.severity === "BLOCK");
  const safe = blocking.length === 0;
  const phaseLabel = phase.replace("_", " ").toLowerCase();

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Execution controls</h2>
        <span className="badge badge-neutral">{phaseLabel}</span>
        <span className="spacer" />
        <span className="mono">policy v{policyVersion}</span>
        <span
          className={
            decision === "BLOCK" ? "badge badge-stop"
            : decision === "PASS" ? "badge badge-ok" : "badge badge-warn"
          }
        >
          {decision}
        </span>
      </div>

      {/* The verdict. Stated only when it is actually true. */}
      <div className={`control-status ${safe ? "ok" : "bad"}`}>
        <span className="ico">
          {safe ? <ShieldCheck size={15} /> : <XCircle size={15} />}
        </span>
        <span>
          <span className="verdict">{safe ? "Safe to proceed" : "Action blocked"}</span>
          <span className="detail">
            {safe
              ? `All ${results.length} controls evaluated${
                  failing.length > 0
                    ? ` · ${failing.length} ${failing.length === 1 ? "needs" : "need"} a human decision, none block`
                    : " · nothing blocks this action"
                }.`
              : blocking.map((rule) => rule.message).join(" ")}
          </span>
        </span>
        <span className="spacer" />
        {!safe && blocking.map((rule) => (
          <span className="mono" key={rule.ruleId} data-testid="guardrail-blocking-rule">
            {rule.ruleId}
          </span>
        ))}
      </div>

      <div className="table-wrap">
        <table className="controls-table" data-testid={`guardrail-table-${phase}`}>
          <thead>
            <tr>
              <th>Control</th>
              <th>Observed</th>
              <th>Limit</th>
              <th style={{ textAlign: "right" }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {results.map((rule) => {
              const expanded = open === rule.ruleId;
              const tone = rule.passed ? "pass" : rule.severity === "BLOCK" ? "stop" : "warn";
              const Icon = rule.passed ? Check : rule.severity === "BLOCK" ? XCircle : AlertTriangle;
              return (
                <tr
                  key={rule.ruleId}
                  className="clickable"
                  aria-expanded={expanded}
                  tabIndex={0}
                  onClick={() => setOpen(expanded ? null : rule.ruleId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpen(expanded ? null : rule.ruleId);
                    }
                  }}
                >
                  <td style={{ paddingRight: 0 }}>
                    <span className="row" style={{ gap: 9, flexWrap: "nowrap" }}>
                      <span className={`control-ico ${tone}`}><Icon strokeWidth={3} /></span>
                      <span style={{ minWidth: 0 }}>
                        <span className="control-name">{rule.label}</span>
                        <span className="control-id" style={{ display: "block" }}>{rule.ruleId}</span>
                      </span>
                    </span>

                    <AnimatePresence initial={false}>
                      {expanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: [0.2, 0.7, 0.3, 1] }}
                          style={{ overflow: "hidden" }}
                        >
                          <div style={{ paddingTop: 8, paddingLeft: 25, maxWidth: "62ch" }}>
                            <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                              {rule.message}
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </td>

                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{rule.observed}</td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{rule.limit}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <span className={`control-result ${tone}`}>
                      {rule.passed ? "PASS" : rule.severity}
                    </span>
                    <ChevronDown
                      size={13}
                      className={`control-chev${expanded ? " open" : ""}`}
                      style={{ marginLeft: 8, verticalAlign: "middle" }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
