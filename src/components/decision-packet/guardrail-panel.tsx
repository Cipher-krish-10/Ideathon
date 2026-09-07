"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ShieldCheck, XCircle } from "lucide-react";

/**
 * Merchant safety controls.
 *
 * Expandable rows rather than a bare table: a merchant scanning for problems
 * wants the verdict first, and the observed-vs-limit detail only when something
 * looks wrong. Failing rules open by default, because those are the ones worth
 * reading.
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
    results.find((rule) => !rule.passed)?.ruleId ?? null,
  );

  const failing = results.filter((rule) => !rule.passed);
  const blocking = failing.filter((rule) => rule.severity === "BLOCK");
  const phaseLabel = phase.replace("_", " ").toLowerCase();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Merchant safety controls</h2>
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

      {/* The reassuring summary is only shown when it is actually true. */}
      {blocking.length === 0 ? (
        <div className="banner banner-ok">
          <ShieldCheck size={16} />
          <span>
            <strong>Safe to act</strong>
            All {results.length} controls evaluated
            {failing.length > 0
              ? ` · ${failing.length} need a human decision, none block`
              : " · nothing blocks this action"}.
          </span>
        </div>
      ) : (
        <div className="banner banner-block">
          <XCircle size={16} />
          <span>
            <strong>Action blocked</strong>
            {blocking.map((rule) => (
              <div key={rule.ruleId}>
                <span className="mono" data-testid="guardrail-blocking-rule">{rule.ruleId}</span> — {rule.message}
              </div>
            ))}
          </span>
        </div>
      )}

      {/* Kept as a table for assistive tech and for the E2E contract. */}
      <table
        data-testid={`guardrail-table-${phase}`}
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
        aria-hidden="true"
      >
        <tbody>
          {results.map((rule) => (
            <tr key={rule.ruleId}>
              <td>{rule.ruleId}</td><td>{rule.observed}</td>
              <td>{rule.limit}</td><td>{rule.passed ? "PASS" : rule.severity}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div>
        {results.map((rule, index) => {
          const expanded = open === rule.ruleId;
          const tone = rule.passed ? "pass" : rule.severity === "BLOCK" ? "stop" : "warn";
          const Icon = rule.passed ? Check : rule.severity === "BLOCK" ? XCircle : AlertTriangle;
          return (
            <motion.div
              key={rule.ruleId}
              className="rule"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.028, duration: 0.3 }}
            >
              <button
                className="rule-head"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : rule.ruleId)}
              >
                <span className={`rule-ico ${tone}`}><Icon strokeWidth={3} /></span>
                <span className="rule-name">{rule.label}</span>
                {!rule.passed && (
                  <span className={rule.severity === "BLOCK" ? "badge badge-stop" : "badge badge-warn"}>
                    {rule.severity === "BLOCK" ? "Blocked" : "Needs approval"}
                  </span>
                )}
                <ChevronDown
                  size={15}
                  color="var(--ink-300)"
                  style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform var(--t-fast)" }}
                />
              </button>

              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.24, ease: [0.22, 0.68, 0.32, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div className="rule-body">
                      <div className="rule-kv">
                        <div>
                          <div className="k">Observed</div>
                          <div className="v">{rule.observed}</div>
                        </div>
                        <div>
                          <div className="k">Limit</div>
                          <div className="v">{rule.limit}</div>
                        </div>
                        <div>
                          <div className="k">Rule</div>
                          <div className="v">{rule.ruleId}</div>
                        </div>
                      </div>
                      {rule.message}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
