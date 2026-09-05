/**
 * Placeholder shell.
 *
 * The UI is deliberately not built yet: this phase delivers the database
 * foundation only. The pages described in ARCHITECTURE.md section 10 arrive
 * once the detector and estimator exist to populate them.
 */
export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: "42rem" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>RevenuePilot</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        AI merchant growth agent — Razorpay Test Mode only.
      </p>
      <p>
        Database foundation is in place. Detector, estimator, guardrails, and the
        decision UI are not built yet.
      </p>
    </main>
  );
}
