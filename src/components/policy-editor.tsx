"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

export function PolicyEditor({
  activeVersion, rules,
}: { activeVersion: number; rules: PolicyRules }) {
  const router = useRouter();
  const [draft, setDraft] = useState<PolicyRules>(rules);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="card">
      <h2>
        Guardrail policy
        <span className="pill pill-accent">v{activeVersion} active</span>
      </h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Saving creates a new version. Existing evaluations keep the version they ran under.
      </p>

      {message && <div className="banner banner-ok" data-testid="policy-saved">{message}</div>}
      {error && <div className="banner banner-block">{error}</div>}

      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Rule</th><th>Severity</th><th>Limit</th><th /></tr>
          </thead>
          <tbody>
            {Object.entries(draft).map(([ruleId, config]) => {
              const limit = config.limit;
              const editable = typeof limit === "number";
              return (
                <tr key={ruleId}>
                  <td className="mono">{ruleId}</td>
                  <td>
                    <span className={config.severity === "BLOCK" ? "pill pill-block" : "pill pill-warn"}>
                      {String(config.severity)}
                    </span>
                  </td>
                  <td>
                    {editable ? (
                      <input
                        type="text"
                        style={{ width: 150 }}
                        data-testid={`limit-${ruleId}`}
                        value={String(limit)}
                        onChange={(event) => {
                          const parsed = Number(event.target.value.replace(/[^\d-]/g, ""));
                          if (Number.isFinite(parsed)) setLimit(ruleId, parsed);
                        }}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {MONEY_RULES.has(ruleId) && typeof limit === "number"
                      ? formatRupees(limit)
                      : ruleId === "MAX_DISCOUNT_BPS" && typeof limit === "number"
                        ? `${(limit / 100).toFixed(2)}%`
                        : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="actions">
        <button className="accent" onClick={save} disabled={busy} data-testid="save-policy">
          {busy ? "Saving…" : "Save as new version"}
        </button>
      </div>
    </div>
  );
}
