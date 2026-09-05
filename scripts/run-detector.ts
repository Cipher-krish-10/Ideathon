/**
 * Development-only detector run.
 *
 * Runs the failed-payment-recovery detector against the seeded demo merchant
 * and prints what it found AND what it rejected. The exclusion breakdown is the
 * point: it demonstrates that the agent discriminated rather than merely
 * counting failed payments.
 *
 *   npm run detector           # dry run, writes nothing
 *   npm run detector -- --persist
 */
import fs from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { EXCLUSION_REASONS } from "../src/core/detectors/index.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { loadMerchantConfig } from "../src/server/dataset/config.js";
import { runFailedPaymentRecoveryDetector } from "../src/server/services/failed-payment-recovery.service.js";

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const persist = process.argv.includes("--persist");
const sampleSize = 8;

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pad = (value: string | number, width: number) => String(value).padEnd(width);
const padStart = (value: string | number, width: number) => String(value).padStart(width);

async function main() {
  const config = loadMerchantConfig();
  const merchant = await prisma.merchant.findUnique({
    where: { sourceRef: config.merchant.merchant_id },
  });
  if (!merchant) {
    console.error(`Merchant "${config.merchant.merchant_id}" not found. Run: npm run db:seed`);
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const result = await runFailedPaymentRecoveryDetector(merchant.id, {
    diagnostics: true,
    dryRun: !persist,
    client: prisma,
  });
  const elapsedMs = Date.now() - startedAt;

  const { detection } = result;
  const { scan, aggregate, exclusionCounts, candidates } = detection;

  console.log("");
  console.log("FAILED PAYMENT RECOVERY DETECTOR");
  console.log("=".repeat(64));
  console.log(`  merchant          ${merchant.name} [${merchant.mode}]`);
  console.log(`  detector          ${detection.detectorVersion}`);
  console.log(`  reference date    ${detection.referenceAt.toISOString()}`);
  console.log(`  recency cutoff    ${detection.recencyCutoff.toISOString()} ` +
    `(${config.detector_config.recency_window_days}d window)`);
  console.log(`  ticket floor      ${rupees(config.detector_config.min_transaction_amount_paise)}`);
  console.log(`  LTV floor         ${rupees(config.detector_config.min_customer_lifetime_value_paise)}`);
  console.log("");

  console.log(`Transactions scanned:   ${scan.transactionsScanned}`);
  console.log(`Payment attempts:       ${scan.paymentAttemptsScanned}`);
  console.log(`Customers:              ${scan.customersScanned}`);
  console.log(`Failed transactions:    ${scan.unpaidTransactions}   (no successful attempt)`);
  if (scan.orphanedPaymentAttempts > 0) {
    console.log(`Orphaned attempts:      ${scan.orphanedPaymentAttempts}`);
  }
  console.log("");

  console.log("QUALIFYING");
  console.log("-".repeat(64));
  console.log(`  candidates        ${aggregate.qualifyingTransactionCount}`);
  console.log(`  customers         ${aggregate.affectedCustomerCount}`);
  console.log(`  value             ${rupees(aggregate.recoverableAmountPaise)}`);
  console.log(`                    (${aggregate.recoverableAmountPaise} paise)`);
  console.log("");

  console.log("EXCLUDED");
  console.log("-".repeat(64));
  const totalExcluded = EXCLUSION_REASONS.reduce((sum, r) => sum + exclusionCounts[r], 0);
  for (const reason of EXCLUSION_REASONS) {
    const count = exclusionCounts[reason];
    // Zero-count reasons are printed too: their absence is itself information.
    console.log(`  ${pad(reason + ":", 26)}${padStart(count, 6)}`);
  }
  console.log(`  ${pad("TOTAL:", 26)}${padStart(totalExcluded, 6)}`);
  console.log("");

  console.log("BY FAILURE REASON (qualifying)");
  console.log("-".repeat(64));
  for (const [reason, count] of Object.entries(aggregate.failureReasonBreakdown)) {
    console.log(`  ${pad(reason + ":", 26)}${padStart(count, 6)}`);
  }
  console.log("");

  console.log("BY CUSTOMER TIER (qualifying)");
  console.log("-".repeat(64));
  for (const [tier, count] of Object.entries(aggregate.tierBreakdown)) {
    console.log(`  ${pad(tier + ":", 26)}${padStart(count, 6)}`);
  }
  console.log("");

  console.log(`SAMPLE CANDIDATES (top ${Math.min(sampleSize, candidates.length)} by value)`);
  console.log("-".repeat(78));
  console.log(
    `  ${pad("customer", 12)}${pad("transaction", 14)}${padStart("amount", 14)}  ` +
      `${pad("failure reason", 24)}${padStart("fails", 6)}`,
  );
  console.log("-".repeat(78));
  for (const candidate of candidates.slice(0, sampleSize)) {
    // Dataset refs and tier only. No email, phone, or name: the detector never
    // needs PII and neither does this output.
    console.log(
      `  ${pad(candidate.customerRef, 12)}${pad(candidate.transactionRef, 14)}` +
        `${padStart(rupees(candidate.amountPaise), 14)}  ` +
        `${pad(candidate.lastFailureReason, 24)}${padStart(candidate.failedAttemptCount, 6)}`,
    );
  }
  console.log("");

  const repeated = candidates.filter((c) => c.failedAttemptCount > 1);
  if (repeated.length > 0) {
    console.log(`REPEATED-FAILURE CANDIDATES (${repeated.length})`);
    console.log("-".repeat(78));
    console.log("  Each is ONE opportunity, not one per attempt.");
    for (const candidate of repeated.slice(0, 5)) {
      console.log(
        `  ${pad(candidate.transactionRef, 14)}${padStart(candidate.failedAttemptCount, 3)} failed attempts` +
          ` -> operative reason ${candidate.lastFailureReason}` +
          ` (attempt ${candidate.operativeAttemptRef})`,
      );
    }
    console.log("");
  }

  if (persist) {
    console.log(
      `PERSISTED: opportunity ${result.opportunityId} ` +
        `(${result.created ? "created" : "reused — idempotent"}), ` +
        `${result.targetsWritten} targets`,
    );
  } else {
    console.log("DRY RUN — nothing written. Re-run with --persist to store the opportunity.");
  }
  console.log(`\nCompleted in ${elapsedMs}ms.`);
}

main()
  .catch((error) => {
    console.error("Detector run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
