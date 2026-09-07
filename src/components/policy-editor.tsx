"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Coins, Gauge, ShieldCheck, Users } from "lucide-react";

import { formatRupees } from "@/lib/format";

/**
 * Policy editor.
 *
 * Editing creates a NEW policy version rather than mutating the active one, so
 * a GuardrailEvaluation that recorded "policy v1" keeps meaning what it meant.
 *
 * This is also the lever for the demo failure beat: lower the daily discount
 * budget below a pending action's discount cost, then attempt approval and
 * watch PRE_EXECUTION block it.
 */
interface PolicyRules {
  [rule: string]: Record<string, unknown>;
}

const MONEY_RULES = new Set([
  "MAX_SINGLE_ACTION_EXPOSURE_PAISE",
  "DAILY_DISCOUNT_BUDGET_PAISE",
  "MIN_EXPECTED_NET_PAISE",
]);

/**
 * Grouped by what the rule protects, not by how it is implemented — a merchant
 * reasons about "how much can this cost me" and "who can it contact", not about
 * severity enums.
 */
const GROUPS = [
  {
    title: "Financial limits", icon: Coins,
    note: "Caps on what a single action, and a day of actions, may cost.",
    rules: ["MAX_DISCOUNT_BPS", "MAX_SINGLE_ACTION_EXPOSURE_PAISE",
            "DAILY_DISCOUNT_BUDGET_PAISE", "MIN_EXPECTED_NET_PAISE"],
  },
  {
    title: "Customer protection", icon: Users,
    note: "Consent and contact frequency. These are absolute.",
    rules: ["DO_NOT_CONTACT", "MAX_CONTACTS_PER_CUSTOMER", "QUIET_HOURS"],
  },
  {
    title: "Execution limits", icon: Gauge,
    note: "How much the agent may have in flight at once.",
    rules: ["MAX_CONCURRENT_LIVE", "LOW_CONFIDENCE"],
  },
  {
    title: "Environment controls", icon: ShieldCheck,
    note: "Non-negotiable. There is no live-mode code path in this build.",
    rules: ["TEST_MODE_ONLY"],
  },
] as const;

const RULE_LABELS: Record<string, string> = {
  MAX_DISCOUNT_BPS: "Maximum discount rate",
  MAX_SINGLE_ACTION_EXPOSURE_PAISE: "Maximum exposure per action",
  DAILY_DISCOUNT_BUDGET_PAISE: "Daily discount budget",
  MIN_EXPECTED_NET_PAISE: "Minimum expected net revenue",
  DO_NOT_CONTACT: "Do-not-contact list",
  MAX_CONTACTS_PER_CUSTOMER: "Contact frequency per customer",
  QUIET_HOURS: "Quiet hours",
  MAX_CONCURRENT_LIVE: "Concurrent live interventions",
  LOW_CONFIDENCE: "Estimate confidence",
  TEST_MODE_ONLY: "Test mode only",
};

export function PolicyEditor({
  activeVersion, rules,
}: { activeVersion: number; rules: PolicyRules }) {
  const router = useRouter();
  const [draft, setDraft] = useState<PolicyRules>(rules);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Save is only offered when something genuinely changed — an always-live
  // primary action trains people to ignore it.
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);

  function setLimit(ruleId: string, value: number) {
    setDraft((current) => ({ ...current, [ruleId]: { ...current[ruleId], limit: value } }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: draft }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "Could not save the policy.");
        return;
      }
      setMessage(`Saved as policy version ${payload.data.activeVersion}.`);
      router.refresh();
    } catch {
      setError("Could not reach the policy service.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Merchant safety controls</h2>
        <span className="badge badge-blue">v{activeVersion} active</span>
        <span className="spacer" />
        {dirty && <span className="badge badge-warn">Unsaved changes</span>}
      </div>

      <div className="panel-body">
        <p className="panel-note">
          Saving creates a new version — a policy is never mutated in place, so an evaluation
          that recorded &ldquo;policy v1&rdquo; keeps meaning what it meant.
        </p>

        {message && (
          <div className="banner banner-ok" data-testid="policy-saved">
            <ShieldCheck size={15} /><span>{message}</span>
          </div>
        )}
        {error && <div className="banner banner-block"><span>{error}</span></div>}

      {GROUPS.map((group) => {
        const Icon = group.icon;
        return (
          <div key={group.title} style={{ marginBottom: "var(--s-6)" }}>
            <div className="row" style={{ gap: 7, marginBottom: 2 }}>
              <Icon size={13} color="var(--ink-400)" strokeWidth={2} />
              <strong style={{ fontSize: 12.5, color: "var(--ink-900)" }}>{group.title}</strong>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 10px 20px" }}>{group.note}</p>

            {group.rules.map((ruleId) => {
              const config = draft[ruleId];
              if (!config) return null;
              const limit = config.limit;
              const editable = typeof limit === "number";
              return (
                <div className="policy-row" key={ruleId}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0" }}>
                    <span className={config.severity === "BLOCK" ? "control-ico stop" : "control-ico warn"}
                          aria-hidden="true">
                      <ShieldCheck strokeWidth={3} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="control-name">{RULE_LABELS[ruleId] ?? ruleId}</span>
                      <div className="mono" style={{ fontSize: 10.5 }}>{ruleId}</div>
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 10.5, letterSpacing: ".05em" }}
                      title={
                        config.severity === "BLOCK"
                          ? "Breaching this rule blocks the action outright"
                          : "Breaching this rule requires a human decision"
                      }
                    >
                      {String(config.severity)}
                    </span>
                    {editable ? (
                      <span className="row" style={{ gap: 8 }}>
                        <input
                          type="text" style={{ width: 132 }}
                          data-testid={`limit-${ruleId}`} value={String(limit)}
                          aria-label={`${RULE_LABELS[ruleId] ?? ruleId} limit`}
                          onChange={(event) => {
                            const parsed = Number(event.target.value.replace(/[^\d-]/g, ""));
                            if (Number.isFinite(parsed)) setLimit(ruleId, parsed);
                          }}
                        />
                        <span className="mono" style={{ minWidth: 82 }}>
                          {MONEY_RULES.has(ruleId)
                            ? formatRupees(limit as number)
                            : ruleId === "MAX_DISCOUNT_BPS"
                              ? `${((limit as number) / 100).toFixed(2)}%`
                              : ""}
                        </span>
                      </span>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>always enforced</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      </div>

      <div className="panel-foot">
        <span className="muted" style={{ fontSize: 11.5 }}>
          Lower the daily discount budget below a pending action&apos;s discount cost to see
          the pre-execution guardrail refuse it.
        </span>
        <span className="spacer" />
        <button className="primary" onClick={save} disabled={busy || !dirty}
                data-testid="save-policy">
          {busy ? "Saving…" : "Save as new version"}
        </button>
      </div>
    </div>
  );
}
