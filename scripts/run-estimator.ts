/**
 * Development-only estimator run.
 *
 * Scores every eligible playbook against the current qualifying opportunity and
 * prints a comparison. The estimator SCORES; it does not choose. The highest
 * expected net is shown as a derived diagnostic only — nothing here is
 * persisted as a decision, and no playbook is marked a winner.
 *
 *   npm run estimator            # dry run, writes nothing
 *   npm run estimator -- --persist
 */
import fs from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { loadMerchantConfig } from "../src/server/dataset/config.js";
import { runFailedPaymentRecoveryDetector } from "../src/server/services/failed-payment-recovery.service.js";
import { runEstimatorForOpportunity } from "../src/server/services/estimator.service.js";

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const persist = process.argv.includes("--persist");

const rupees = (paise: number) =>
  `${paise < 0 ? "-" : ""}₹${Math.abs(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const pad = (v: string | number, w: number) => String(v).padEnd(w);
const padStart = (v: string | number, w: number) => String(v).padStart(w);

async function main() {
  const config = loadMerchantConfig();
  const merchant = await prisma.merchant.findUnique({
    where: { sourceRef: config.merchant.merchant_id },
  });
  if (!merchant) {
    console.error(`Merchant not found. Run: npm run db:seed`);
    process.exitCode = 1;
    return;
  }

  // Ensure a persisted opportunity exists to score. Idempotent either way.
  const detection = await runFailedPaymentRecoveryDetector(merchant.id, {
    client: prisma,
    diagnostics: false,
  });
  const opportunityId = detection.opportunityId;
  if (!opportunityId) throw new Error("Detector produced no opportunity to score");

  const result = await runEstimatorForOpportunity(opportunityId, {
    client: prisma,
    dryRun: !persist,
  });

  console.log("");
  console.log("FAILED PAYMENT RECOVERY — ESTIMATES");
  console.log("=".repeat(96));
  console.log(`  merchant          ${merchant.name} [${merchant.mode}]`);
  console.log(`  estimator         ${result.estimatorVersion}`);
  console.log(`  opportunity       ${opportunityId}`);
  console.log("");
  console.log("Opportunity:");
  console.log(`  ${detection.detection.aggregate.affectedCustomerCount} customers`);
  console.log(
    `  ${rupees(detection.detection.aggregate.recoverableAmountPaise)} at risk ` +
      `across ${result.targetCount} transactions`,
  );
  console.log("");

  console.log(
    pad("PLAYBOOK", 36) + padStart("AVG p", 9) + padStart("EXP GROSS", 15) +
      padStart("COST", 13) + padStart("EXP NET", 15) + "  CONFIDENCE",
  );
  console.log("-".repeat(96));
  for (const candidate of result.candidates) {
    console.log(
      pad(candidate.inputsSnapshot.playbookName, 36) +
        padStart(pct(candidate.pRecoverAvgBps), 9) +
        padStart(rupees(candidate.expectedGrossPaise), 15) +
        padStart(rupees(candidate.costPaise), 13) +
        padStart(rupees(candidate.expectedNetPaise), 15) +
        "  " + candidate.confidence,
    );
  }
  console.log("");

  console.log("COST BREAKDOWN");
  console.log("-".repeat(96));
  console.log(
    pad("PLAYBOOK", 36) + padStart("DISCOUNT", 14) + padStart("CHANNEL", 12) +
      padStart("GATEWAY FEE", 14) + padStart("TOTAL COST", 14),
  );
  for (const candidate of result.candidates) {
    console.log(
      pad(candidate.playbookKey, 36) +
        padStart(rupees(candidate.discountCostPaise), 14) +
        padStart(rupees(candidate.channelCostPaise), 12) +
        padStart(rupees(candidate.gatewayFeePaise), 14) +
        padStart(rupees(candidate.costPaise), 14),
    );
  }
  console.log("");

  // A worked example, so every figure on screen can be traced to inputs.
  const sample = result.candidates[0];
  const firstTarget = sample?.inputsSnapshot.targets[0];
  if (sample && firstTarget) {
    console.log(`WORKED EXAMPLE — ${sample.playbookKey}, target ${firstTarget.transactionRef}`);
    console.log("-".repeat(96));
    console.log(`  failure reason        ${firstTarget.failureReason}`);
    console.log(`  customer tier         ${firstTarget.customerTier}  (${firstTarget.customerRef})`);
    console.log(`  failure age           ${firstTarget.failureAgeDays} days`);
    console.log(`  base rate             ${pct(firstTarget.baseRateBps)}   (Beta prior, n=${firstTarget.priorSampleSize})`);
    console.log(`  x recency modifier    ${(firstTarget.recencyModifierBps / 10000).toFixed(4)}`);
    console.log(`  x tier modifier       ${(firstTarget.tierModifierBps / 10000).toFixed(4)}`);
    console.log(`  x incentive modifier  ${(firstTarget.incentiveModifierBps / 10000).toFixed(4)}`);
    console.log(`  = p_recover           ${pct(firstTarget.pRecoverBps)}`);
    console.log(`  amount                ${rupees(firstTarget.amountPaise)}`);
    console.log(`  expected gross        ${rupees(firstTarget.expectedGrossPaise)}`);
    console.log(`  discount cost         ${rupees(firstTarget.discountCostPaise)}`);
    console.log(`  gateway fee           ${rupees(firstTarget.gatewayFeePaise)}`);
    console.log("");
  }

  // Derived diagnostic only. The estimator does not rank, and nothing about
  // this line is persisted: choosing is the reasoner's job in a later phase.
  const byNet = [...result.candidates].sort((a, b) => b.expectedNetPaise - a.expectedNetPaise);
  const top = byNet[0];
  if (top) {
    console.log(
      `Highest expected net candidate (derived, not a decision): ` +
        `${top.playbookKey} at ${rupees(top.expectedNetPaise)}`,
    );
  }

  if (persist) {
    console.log(
      `\nPERSISTED: ${result.created} created, ${result.reused} reused ` +
        `(estimator ${result.estimatorVersion})`,
    );
  } else {
    console.log("\nDRY RUN — nothing written. Re-run with --persist to store estimates.");
  }
}

main()
  .catch((error) => {
    console.error("Estimator run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
