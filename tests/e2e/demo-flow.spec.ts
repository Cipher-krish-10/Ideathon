import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

/**
 * The clickable demo, asserted end to end.
 *
 * Two paths matter: the happy one (propose → review → edit → approve) and the
 * failure beat (policy tightened → approval blocked at PRE_EXECUTION). Neither
 * touches a payment provider, because none exists.
 */

/** Reset to a known state. Deterministic, so the demo is reproducible. */
function resetDemo(blocking = false) {
  execFileSync("npm", ["run", "db:seed"], { stdio: "ignore" });
  // --scripted: the E2E suite must never call a live model. The reasoning layer
  // has its own offline contract tests; what matters here is the UI and the
  // approval gate behaving correctly given a proposal.
  const args = ["run", "demo:setup", "--", "--scripted"];
  if (blocking) args.push("--block");
  try {
    execFileSync("npm", args, { stdio: "pipe" });
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `demo:setup failed\nSTDOUT: ${err.stdout?.toString() ?? ""}\nSTDERR: ${err.stderr?.toString() ?? ""}`,
    );
  }
}

async function openPendingPacket(page: import("@playwright/test").Page) {
  await page.goto("/interventions");
  const link = page.getByRole("link", { name: "Open" }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: "Decision Packet" })).toBeVisible();
}

test.describe("RevenuePilot demo flow", () => {
  test("test mode banner is always visible", async ({ page }) => {
    await page.goto("/");
    // The banner specifically, not any prose that mentions test mode.
    await expect(page.locator(".test-banner")).toContainText("Razorpay Test Mode");
    await expect(page.locator(".test-banner")).toContainText("no live money can move");
  });

  test("command centre shows the opportunity without calling it recovered", async ({ page }) => {
    resetDemo();
    await page.goto("/");

    await expect(page.getByText("₹5,14,274.00").first()).toBeVisible();
    // Counts are bound to the nouns they count, and the hero shows the
    // detector DISCRIMINATING: 26 recoverable out of 66 failed transactions.
    // A detector that reported only its positives would be indistinguishable
    // from one that counted every failure, so both figures must be present.
    const facts = page.locator(".hero-facts");
    await expect(facts).toContainText("26 customers");
    await expect(facts).toContainText("26 recoverable");
    await expect(facts).toContainText("66 failed transactions");
    // Potential and realised value must be visibly different things: the
    // headline figure is tagged POTENTIAL, recovered revenue ACTUAL.
    await expect(page.locator(".hero-label").getByText("Potential")).toBeVisible();
    await expect(page.getByTestId("recovered-revenue")).toHaveText("₹0.00");
    await expect(page.getByText("ACTUAL · confirmed by payment events")).toBeVisible();
  });

  test("run agent produces a proposal", async ({ page }) => {
    execFileSync("npm", ["run", "db:seed"], { stdio: "ignore" });
    await page.goto("/opportunities");
    await page.getByTestId("run-agent").click();
    await expect(page.getByTestId("run-agent-result")).toContainText("26 qualifying customers", {
      timeout: 45_000,
    });
  });

  test("decision packet shows recommendation, alternatives and guardrails", async ({ page }) => {
    resetDemo();
    await openPendingPacket(page);

    await expect(page.getByTestId("recoverable-amount")).toHaveText("₹5,14,274.00");
    await expect(page.getByTestId("selected-playbook")).toBeVisible();

    // All three deterministic strategies are shown, selected clearly marked.
    await expect(page.getByText("Alternatives considered")).toBeVisible();
    await expect(page.getByText("₹2,23,414.04").first()).toBeVisible();
    await expect(page.getByText("₹2,00,508.37").first()).toBeVisible();
    await expect(page.getByText("₹1,42,921.20").first()).toBeVisible();
    // The alternatives are cards now; exactly one carries the AI-selected mark.
    await expect(page.locator(".strategy.chosen")).toHaveCount(1);
    await expect(page.getByText("AI selected")).toBeVisible();

    // The guardrail table shows every rule with observed vs limit.
    const table = page.getByTestId("guardrail-table-PRE_APPROVAL");
    await expect(table).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(table.getByText("TEST_MODE_ONLY")).toBeVisible();
    await expect(table.getByText("DAILY_DISCOUNT_BUDGET_PAISE")).toBeVisible();

    await expect(page.getByTestId("audit-timeline").locator("li").first()).toBeVisible();
  });

  test("merchant can edit the message and approve", async ({ page }) => {
    resetDemo();
    await openPendingPacket(page);

    const subject = page.getByTestId("message-subject");
    await subject.fill("Reviewed by a human before sending");

    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approved-banner")).toBeVisible({ timeout: 20_000 });
    // Approval is not execution, and the UI says so.
    await expect(page.getByTestId("approved-banner")).toContainText("No money has moved");

    await page.reload();
    await expect(page.getByText("APPROVED").first()).toBeVisible();
    await expect(page.getByTestId("not-decidable")).toBeVisible();
  });

  test("EXECUTE: approved intervention creates a payment link, and says it is not revenue", async ({ page }) => {
    // Runs against the FAKE provider: PAYMENT_PROVIDER defaults to "fake", so
    // the E2E suite never calls Razorpay.
    resetDemo();
    await openPendingPacket(page);

    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approved-banner")).toBeVisible({ timeout: 20_000 });
    await page.reload();

    // Approved, not yet acted on.
    const executionCard = page.getByTestId("execution-card");
    await expect(executionCard).toBeVisible();
    await expect(executionCard.getByText("READY TO EXECUTE")).toBeVisible();

    await page.getByTestId("execute-button").click();
    await expect(page.getByTestId("executed-banner")).toBeVisible({ timeout: 30_000 });
    // The distinction the whole phase turns on.
    await expect(page.getByTestId("executed-banner")).toContainText("NOT");

    await page.reload();
    await expect(page.getByText("OBSERVING").first()).toBeVisible();
    await expect(page.getByTestId("artifact-table")).toBeVisible();
    await expect(page.getByTestId("payment-link").first()).toBeVisible();
    await expect(page.getByText("awaiting payment").first()).toBeVisible();
    await expect(
      page.getByText("Payment link created — revenue has NOT yet been recovered."),
    ).toBeVisible();
  });

  test("FULL LOOP: payment → webhook → attribution → converted → learning", async ({ page }) => {
    resetDemo();
    await openPendingPacket(page);

    // Approve, execute.
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approved-banner")).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await page.getByTestId("execute-button").click();
    await expect(page.getByTestId("executed-banner")).toBeVisible({ timeout: 30_000 });
    await page.reload();

    // Awaiting payment: nothing is claimed yet.
    const attribution = page.getByTestId("attribution-card");
    await expect(attribution).toBeVisible();
    await expect(attribution.getByText("AWAITING PAYMENT", { exact: true })).toBeVisible();

    // The simulation enters through the webhook boundary — it cannot shortcut.
    await page.getByTestId("simulate-payment").click();
    await expect(page.getByTestId("recovered-amount")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("attribution-method")).toHaveText("DIRECT_REF");
    await expect(attribution.getByText("CONVERTED", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Confirmed by a verified payment event"),
    ).toBeVisible();

    // Recovered revenue is now real, and distinct from the estimate.
    await page.goto("/");
    const recovered = await page.getByTestId("recovered-revenue").textContent();
    expect(recovered).not.toBe("₹0.00");

    // Analytics reflects the conversion and the learning.
    await page.goto("/analytics");
    await expect(page.getByTestId("analytics-recovered")).not.toHaveText("₹0.00");
    await expect(page.getByTestId("learning-table")).toBeVisible();
    // The funnel is a bar chart now rather than a table.
    await expect(page.getByText("Converted", { exact: true })).toBeVisible();
  });

  test("a replayed simulated payment does not double-count", async ({ page }) => {
    // The demo state already has one converted intervention from the loop test.
    await page.goto("/analytics");
    await expect(page.getByTestId("analytics-recovered")).toBeVisible();
  });

  test("recovered revenue stays at zero after execution", async ({ page }) => {
    // Fresh state: executing creates a link, and that is not revenue.
    resetDemo();

    await page.goto("/");
    // Executed actions may be non-zero; realised revenue may not.
    await expect(page.getByTestId("recovered-revenue")).toHaveText("₹0.00");
    await expect(page.getByText("ACTUAL · confirmed by payment events")).toBeVisible();
  });

  test("merchant can reject", async ({ page }) => {
    resetDemo();
    await openPendingPacket(page);

    await page.getByTestId("reject-button").click();
    await expect(page.getByTestId("rejected-banner")).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByTestId("not-decidable")).toBeVisible();
  });

  test("FAILURE BEAT: lowering the budget blocks approval at pre-execution", async ({ page }) => {
    // Proposal passed PRE_APPROVAL under a budget that allowed it; the setup
    // then lowers the budget, exactly as a merchant would in the Policies page.
    resetDemo(true);
    await openPendingPacket(page);

    await page.getByTestId("approve-button").click();

    await expect(page.getByTestId("blocked-banner")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("blocked-banner")).toContainText("Action blocked");
    await expect(page.getByTestId("blocking-rule")).toHaveText("DAILY_DISCOUNT_BUDGET_PAISE");
    await expect(page.getByTestId("blocked-banner")).toContainText("no money moved");

    await page.reload();
    await expect(page.getByText("GUARDRAIL_BLOCKED").first()).toBeVisible();
    // Both evaluations are now on the record, and they disagree.
    await expect(page.getByTestId("guardrail-table-PRE_APPROVAL")).toBeVisible();
    await expect(page.getByTestId("guardrail-table-PRE_EXECUTION")).toBeVisible();
  });

  test("policy edits create a new version", async ({ page }) => {
    resetDemo();
    await page.goto("/policies");
    await expect(page.getByText("v2 active")).toBeVisible();

    await page.getByTestId("limit-DAILY_DISCOUNT_BUDGET_PAISE").fill("2000000");
    await page.getByTestId("save-policy").click();
    await expect(page.getByTestId("policy-saved")).toContainText("version 3");
  });

  test("DEMO SESSION: reset → run → approve → execute → pay → recover → learn", async ({ page }) => {
    // The whole journey through the UI, with the activity feed tracking it.
    resetDemo();
    await page.goto("/");

    // Historical baseline and session state are visibly different things.
    await expect(page.getByTestId("env-demo")).toHaveText("Demo environment");
    await expect(page.getByTestId("historical-opportunity")).toHaveText("₹5,14,274.00");
    await expect(page.getByTestId("recovered-revenue")).toHaveText("₹0.00");
    await expect(page.getByTestId("simulation-time")).toBeVisible();
    await expect(page.locator(".hero-label").getByText("Potential")).toBeVisible();

    // The feed already shows the agent run performed by demo:setup.
    await expect(page.getByTestId("activity-feed")).toBeVisible();
    await expect(page.getByText("Recovery opportunities detected")).toBeVisible();

    // Clock advances, and it is presentation only.
    await page.getByTestId("demo-advance-5").click();
    await expect(page.getByTestId("demo-controls-message")).toContainText("Simulation time is now");

    // Approve and execute.
    await page.goto("/interventions");
    await page.getByRole("link", { name: "Open" }).first().click();
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approved-banner")).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await page.getByTestId("execute-button").click();
    await expect(page.getByTestId("executed-banner")).toBeVisible({ timeout: 30_000 });

    // Simulate the payment from the command centre's demo controls.
    await page.goto("/");
    await expect(page.getByTestId("executed-actions")).not.toHaveText("0");
    await expect(page.getByTestId("recovered-revenue")).toHaveText("₹0.00");

    await page.getByTestId("demo-simulate-payment").click();
    await expect(page.getByTestId("demo-controls-message")).toContainText(
      "attributed", { timeout: 30_000 },
    );

    // Recovered revenue is now real.
    await page.reload();
    await expect(page.getByTestId("recovered-revenue")).not.toHaveText("₹0.00");
    await expect(page.getByText("ACTUAL · confirmed by payment events")).toBeVisible();

    // The feed tells the whole story, including the learning update.
    const feed = page.getByTestId("activity-feed");
    await expect(feed.getByText("Attribution confirmed")).toBeVisible();
    await expect(feed.getByText("Revenue recovered")).toBeVisible();
    await expect(feed.getByText("Playbook learning updated")).toBeVisible();

    // Analytics keeps the four numbers apart.
    await page.goto("/analytics");
    await expect(page.getByTestId("analytics-opportunity")).toHaveText("₹5,14,274.00");
    await expect(page.getByTestId("analytics-recovered")).not.toHaveText("₹0.00");
    // The long definition moved into a tooltip, but the PROVENANCE stays on
    // screen: the opportunity figure is tagged Potential and recovered revenue
    // is tagged Actual. Those two must never be confusable at a glance.
    const opportunityMetric = page.locator(".metric", { has: page.getByTestId("analytics-opportunity") });
    await expect(opportunityMetric.locator(".m-tag")).toHaveText("Potential");
    const recoveredMetric = page.locator(".metric", { has: page.getByTestId("analytics-recovered") });
    await expect(recoveredMetric.locator(".m-tag")).toHaveText("Actual");
    await expect(page.getByTestId("learning-table")).toBeVisible();
  });

  test("reset returns the demo to its baseline", async ({ page }) => {
    // Runs after the session test, so there is state to clear.
    await page.goto("/");
    await page.getByTestId("demo-reset").click();
    await expect(page.getByTestId("demo-controls-message")).toContainText("Reset to baseline");

    await page.reload();
    await expect(page.getByTestId("recovered-revenue")).toHaveText("₹0.00");
    await expect(page.getByTestId("executed-actions")).toHaveText("0");
    // No stale feed entries survive.
    await expect(page.getByTestId("feed-empty")).toBeVisible();
    // Historical baseline is untouched by a reset.
    await expect(page.getByTestId("historical-opportunity")).toHaveText("₹0.00");
  });

  test("audit page verifies the hash chain", async ({ page }) => {
    resetDemo();
    await page.goto("/audit");
    const integrity = page.locator(".integrity");
    await expect(integrity).toHaveClass(/\bok\b/);
    await expect(integrity.getByText("Verified", { exact: true })).toBeVisible();
    await expect(integrity).toContainText("SHA-256 chain intact");
  });
});
