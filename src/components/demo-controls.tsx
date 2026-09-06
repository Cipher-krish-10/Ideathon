"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Demo controls.
 *
 * A convenience, never an authority layer. None of these bypass a guardrail, an
 * approval, the webhook pipeline, or the attribution engine — the payment
 * control posts a signed event through the same receiver a real webhook hits.
 * All of them require DEMO_MODE server-side.
 */
export function DemoControls({
  enabled, artifactId,
}: { enabled: boolean; artifactId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!enabled) {
    return (
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        Simulation controls are disabled outside DEMO_MODE.
      </p>
    );
  }

  async function call(label: string, url: string, body?: unknown) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      setMessage(
        response.ok
          ? describe(label, payload.data)
          : (payload.error?.message ?? "That did not work."),
      );
      router.refresh();
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="controls">
        <button
          onClick={() => call("reset", "/api/simulation/reset")}
          disabled={busy !== null}
          data-testid="demo-reset"
        >
          {busy === "reset" ? "Resetting…" : "Reset demo"}
        </button>
        <button
          onClick={() => call("+1 min", "/api/simulation/advance", { minutes: 1 })}
          disabled={busy !== null}
          data-testid="demo-advance-1"
        >
          +1 min
        </button>
        <button
          onClick={() => call("+5 min", "/api/simulation/advance", { minutes: 5 })}
          disabled={busy !== null}
          data-testid="demo-advance-5"
        >
          +5 min
        </button>
        <button
          onClick={() => artifactId && call("payment", "/api/simulate/payment", { artifactId })}
          disabled={busy !== null || !artifactId}
          title={artifactId ? undefined : "Execute an intervention first"}
          data-testid="demo-simulate-payment"
        >
          {busy === "payment" ? "Delivering event…" : "Simulate successful payment"}
        </button>
      </div>
      {message && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }} data-testid="demo-controls-message">
          {message}
        </p>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
        The payment control posts a signed provider event through the same webhook
        receiver a real payment uses. It cannot mark anything converted by itself.
      </p>
    </div>
  );
}

function describe(label: string, data: Record<string, unknown>): string {
  if (label === "reset") {
    return `Reset to baseline — removed ${data.opportunitiesRemoved ?? 0} opportunities, ` +
      `${data.interventionsRemoved ?? 0} interventions, ${data.auditEntriesRemoved ?? 0} audit entries. ` +
      "Historical records untouched.";
  }
  if (label === "payment") {
    const status = String(data.status ?? "");
    if (status === "DUPLICATE") return "Already delivered — nothing was double-counted.";
    const attribution = data.attribution as { attributed?: boolean; reason?: string } | undefined;
    return attribution?.attributed
      ? "Payment delivered, attributed, and learning updated."
      : `Payment delivered, but attribution refused: ${attribution?.reason ?? "unresolved"}.`;
  }
  return `Simulation time is now ${new Date(String(data.simulatedNow)).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}.`;
}
