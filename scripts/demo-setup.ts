/**
 * Reset the demo to a known, reproducible state.
 *
 *   npm run demo:setup            # ready to approve
 *   npm run demo:setup -- --block # ready to show the guardrail block
 *
 * WHY A SETUP STEP EXISTS
 *
 * With the seeded policy v1, the highest expected-net candidate
 * (PAYMENT_LINK_WITH_OFFER) is BLOCKED at PRE_APPROVAL: its discount cost of
 * ₹25,331.91 exceeds the ₹25,000.00 daily discount budget by ₹331.91. That is
 * a genuine, correct evaluation, not a bug -- but it means the proposal never
 * reaches a human, so there is nothing to approve.
 *
 * This script raises the daily budget to ₹30,000 (creating policy v2) so the
 * proposal reaches PENDING_APPROVAL. Lowering it again during the demo is then
 * what triggers the PRE_EXECUTION block.
 */
import fs from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { ScriptedLlmProvider } from "../src/integrations/llm/index.js";
import { loadMerchantConfig } from "../src/server/dataset/config.js";
import { runAgentCycle } from "../src/server/services/agent-run.service.js";

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 3 }) });

/** Headroom so the offer playbook's ₹25,331.91 discount cost fits. */
const DEMO_BUDGET_PAISE = 3_000_000; // ₹30,000
/** Below the discount cost, so PRE_EXECUTION blocks. */
const BLOCKING_BUDGET_PAISE = 2_000_000; // ₹20,000

const wantBlockState = process.argv.includes("--block");
/**
 * Force the fixture provider.
 *
 * The E2E suite uses this: a test that calls a live model is a test that fails
 * for reasons unrelated to the code, and rate limits make it worse the more
 * often it runs.
 */
const forceScripted = process.argv.includes("--scripted");
const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

/**
 * A fixture response so the demo does not depend on a model being reachable.
 * Used only when no LLM credential is configured; with a key set, the real
 * provider runs instead.
 */
function scriptedProvider(playbookId: string) {
  return new ScriptedLlmProvider([
    JSON.stringify({
      selectedPlaybookId: playbookId,
      rationale:
        "Under the merchant's configured recovery model, the discounted payment link " +
        "carries the highest expected net revenue of the three candidates, at " +
        "₹2,23,414.04 against ₹2,00,508.37 for the plain link. That margin comes from a " +
        "materially higher modelled recovery rate, 49.26% versus 39.79%, which more than " +
        "offsets the discount cost. The plain link remains a reasonable lower-cost " +
        "alternative if the merchant would rather protect margin, since its cost is only " +
        "₹4,105.25.",
      customerMessage: {
        subject: "A little help completing your payment",
        body:
          "Hello,\n\nWe noticed your recent payment of {{amount}} didn't go through — " +
          "these things usually just need another attempt.\n\nTo make it easy, here's a " +
          "link with 10% off: {{payment_link}}\n\nIf you've already paid, please ignore " +
          "this message.\n\nThank you.",
      },
      risksIdentified: [
        "Discount reduces margin on customers who would have paid without an incentive.",
        "Confidence is MEDIUM: priors are seeded calibration with no recorded outcomes yet.",
        "Contacting 26 customers at once concentrates reputational risk if copy misfires.",
      ],
      confidenceNote:
        "Confidence is MEDIUM, matching the estimator. The ranking between candidates is " +
        "clear, but the underlying recovery rates are configured calibration rather than " +
        "measured outcomes, so the absolute figures should be treated as modelled.",
    }),
  ]);
}

async function setPolicyBudget(merchantId: string, budgetPaise: number, adminId: string) {
  const latest = await prisma.guardrailPolicy.findFirstOrThrow({
    where: { merchantId }, orderBy: { version: "desc" },
  });
  const rules = latest.rules as Record<string, Record<string, unknown>>;
  const updated = {
    ...rules,
    DAILY_DISCOUNT_BUDGET_PAISE: {
      ...rules.DAILY_DISCOUNT_BUDGET_PAISE,
      limit: budgetPaise,
    },
  };

  await prisma.guardrailPolicy.updateMany({
    where: { merchantId, isActive: true }, data: { isActive: false },
  });
  return prisma.guardrailPolicy.create({
    data: {
      merchantId, version: latest.version + 1, rules: updated,
      isActive: true, updatedById: adminId,
    },
  });
}

async function main() {
  const config = loadMerchantConfig();
  const merchant = await prisma.merchant.findUnique({
    where: { sourceRef: config.merchant.merchant_id },
  });
  if (!merchant) {
    console.error("Merchant not found. Run: npm run db:seed");
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.user.findFirstOrThrow({
    where: { merchantId: merchant.id, role: "ADMIN" },
  });

  // Headroom first, so the proposal reaches a human.
  const policy = await setPolicyBudget(merchant.id, DEMO_BUDGET_PAISE, admin.id);
  console.log(`  policy v${policy.version}: daily discount budget ${rupees(DEMO_BUDGET_PAISE)}`);

  const playbooks = await prisma.playbook.findMany({ where: { merchantId: merchant.id } });
  const offer = playbooks.find((p) => p.key === "PAYMENT_LINK_WITH_OFFER");

  const useScripted =
    forceScripted || (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY);
  const result = await runAgentCycle(merchant.id, {
    client: prisma,
    ...(useScripted && offer ? { provider: scriptedProvider(offer.id) } : {}),
  });

  console.log(`  detector:   ${result.qualifyingCandidates} candidates, ${rupees(result.recoverableAmountPaise)}`);
  console.log(`  reasoner:   ${result.reasoningMode}${useScripted ? " (scripted fixture)" : ""}`);
  console.log(`  guardrails: ${result.guardrail?.decision ?? "—"}`);
  console.log(`  state:      ${result.interventionState}`);

  if (wantBlockState) {
    const blocking = await setPolicyBudget(merchant.id, BLOCKING_BUDGET_PAISE, admin.id);
    console.log(
      `\n  policy v${blocking.version}: daily discount budget lowered to ` +
        `${rupees(BLOCKING_BUDGET_PAISE)} — approval will now be blocked at PRE_EXECUTION.`,
    );
  }

  console.log(`\n  Decision packet: http://localhost:3000/interventions/${result.interventionId}`);
}

main()
  .catch((error) => {
    console.error("Demo setup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
