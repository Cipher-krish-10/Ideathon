"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Runs the agent cycle.
 *
 * The whole pipeline is idempotent, so pressing this twice converges on the
 * same proposal rather than creating a second one.
 */
export function RunAgentButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/agent/run", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error?.message ?? "The agent run failed.");
        return;
      }
      const data = payload.data;
      setMessage(
        `Found ${data.qualifyingCandidates} qualifying customers. ` +
          `Proposal is ${data.interventionState ?? "unavailable"} ` +
          `(${data.reasoningMode ?? "—"}).`,
      );
      router.refresh();
    } catch {
      setError("Could not reach the agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="accent" onClick={run} disabled={busy} data-testid="run-agent">
        {busy ? "Running agent…" : "Run Agent"}
      </button>
      {message && <p className="muted" style={{ fontSize: 13 }} data-testid="run-agent-result">{message}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--block)" }}>{error}</p>}
    </div>
  );
}
