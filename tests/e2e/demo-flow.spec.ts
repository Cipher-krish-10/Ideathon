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
  const link = page.getByRole("link", { name: "Open →" }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: "Decision Packet" })).toBeVisible();
}

test.describe("RevenuePilot demo flow", () => {
  test("test mode banner is always visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Razorpay Test Mode")).toBeVisible();
  });

  test("command centre shows the opportunity without calling it recovered", async ({ page }) => {
    resetDemo();
    await page.goto("/");

    await expect(page.getByText("₹5,14,274.00")).toBeVisible();
    await expect(page.getByText("26", { exact: true }).first()).toBeVisible();
    // Potential value must never be presented as money already earned.
    await expect(page.getByText("Potential — not yet recovered")).toBeVisible();
    await expect(page.getByText("Nothing has executed yet")).toBeVisible();
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
    await expect(page.locator("tr.selected")).toHaveCount(1);

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

  test("audit page verifies the hash chain", async ({ page }) => {
    resetDemo();
    await page.goto("/audit");
    await expect(page.getByText("Integrity verified")).toBeVisible();
  });
});
