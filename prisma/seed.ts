/**
 * Seed the RevenuePilot database from the APPROVED synthetic dataset.
 *
 * Loads data/*.csv and data/merchant_config.json exactly as generated. The
 * dataset is immutable source data: this script transforms representation
 * (snake_case -> enums, ISO strings -> Date) but never invents, derives, or
 * adjusts a value.
 *
 * It deliberately does NOT compute opportunities, estimates, or interventions.
 * The database holds the SOURCE OF TRUTH only; everything the agent concludes
 * is derived later, at runtime, by the detector and estimator.
 *
 *   npm run db:seed
 */
import fs from "node:fs";
import path from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { PrismaPg } from "@prisma/adapter-pg";
import { parse } from "csv-parse/sync";

import { PrismaClient } from "../src/generated/prisma/client.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import {
  datasetSummarySchema,
  merchantConfigSchema,
  toMilli,
} from "../src/server/dataset/config.js";
import {
  parseOptionalTimestamp,
  parsePaise,
  parseTimestamp,
  toAttemptStatus,
  toCustomerTier,
  toFailureReason,
  toPaymentMethod,
  toPlaybookActionType,
  toProductCategory,
  toSuppressionReason,
  toTransactionStatus,
} from "../src/server/dataset/mappings.js";

const DATA_DIR = path.join(process.cwd(), "data");
const CHUNK = 500;

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

type Row = Record<string, string>;

function readCsv(filename: string): Row[] {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), "utf8");
  return parse(raw, { columns: true, skip_empty_lines: true, bom: true }) as Row[];
}

function readJson<T>(filename: string, schema: { parse: (v: unknown) => T }): T {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), "utf8");
  return schema.parse(JSON.parse(raw));
}

/** Required cell accessor — a missing column is a dataset contract breach. */
function cell(row: Row, column: string, file: string): string {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`Column "${column}" missing from ${file}`);
  }
  return value;
}

async function chunked<T>(items: T[], fn: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += CHUNK) {
    await fn(items.slice(i, i + CHUNK));
  }
}

async function main() {
  const startedAt = Date.now();
  console.log("RevenuePilot seed — loading approved dataset from data/\n");

  const config = readJson("merchant_config.json", merchantConfigSchema);
  const summary = readJson("dataset_summary.json", datasetSummarySchema);

  const customerRows = readCsv("customers.csv");
  const productRows = readCsv("products.csv");
  const transactionRows = readCsv("transactions.csv");
  const attemptRows = readCsv("payment_attempts.csv");

  // Fail before writing anything if the files do not match their own summary.
  const expected = summary.row_counts;
  const actual = {
    customers: customerRows.length,
    products: productRows.length,
    transactions: transactionRows.length,
    payment_attempts: attemptRows.length,
  };
  for (const [key, count] of Object.entries(actual)) {
    const want = expected[key as keyof typeof actual];
    if (count !== want) {
      throw new Error(
        `Dataset drift: ${key}.csv has ${count} rows, dataset_summary.json expects ${want}. ` +
          "The dataset is immutable — do not regenerate it.",
      );
    }
  }

  // ---- Reset. Merchant cascade clears every child table. -------------------
  // The audit log is append-only by trigger; purging it needs an explicit
  // session opt-in, which is exactly the friction we want around a reset.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL revenuepilot.allow_audit_purge = 'on'");
    await tx.merchant.deleteMany({ where: { sourceRef: config.merchant.merchant_id } });
  });

  // ---- 1. Merchant --------------------------------------------------------
  const merchant = await prisma.merchant.create({
    data: {
      sourceRef: config.merchant.merchant_id,
      name: config.merchant.name,
      businessType: config.merchant.business_type,
      timezone: config.merchant.timezone,
      currency: config.merchant.currency,
      mode: config.merchant.mode,
      datasetReferenceAt: parseTimestamp(
        config.dataset.reference_datetime,
        "dataset.reference_datetime",
      ),
      datasetSeed: config.dataset.seed,
      datasetVersion: config.dataset.generator_version,
    },
  });
  console.log(`  merchant           ${merchant.name} (${merchant.sourceRef})`);

  // ---- 2. Users -----------------------------------------------------------
  // Two roles because the approval gate is a role boundary, not a checkbox:
  // the demo must show that only an APPROVER can release a money action.
  const users = await prisma.user.createManyAndReturn({
    data: [
      {
        merchantId: merchant.id,
        email: "admin@nimbuscommerce.test",
        name: "Demo Admin",
        role: "ADMIN",
      },
      {
        merchantId: merchant.id,
        email: "approver@nimbuscommerce.test",
        name: "Demo Approver",
        role: "APPROVER",
      },
    ],
  });
  const admin = users.find((u) => u.role === "ADMIN");
  if (!admin) {
    throw new Error("Failed to create the demo ADMIN user");
  }
  console.log(`  users              ${users.length} (ADMIN, APPROVER)`);

  // ---- 3. Customers -------------------------------------------------------
  await chunked(customerRows, (batch) =>
    prisma.customer.createMany({
      data: batch.map((row) => {
        const dnc = parseOptionalTimestamp(
          cell(row, "do_not_contact_until", "customers.csv"),
          "do_not_contact_until",
        );
        const reason = cell(row, "suppression_reason", "customers.csv");
        return {
          merchantId: merchant.id,
          sourceRef: cell(row, "customer_id", "customers.csv"),
          externalRef: cell(row, "external_ref", "customers.csv"),
          maskedEmail: cell(row, "masked_email", "customers.csv"),
          maskedPhone: cell(row, "masked_phone", "customers.csv"),
          city: cell(row, "city", "customers.csv"),
          signupAt: parseTimestamp(cell(row, "signup_at", "customers.csv"), "signup_at"),
          historicalValuePaise: parsePaise(
            cell(row, "historical_value_paise", "customers.csv"),
            "historical_value_paise",
          ),
          lifetimeValuePaise: parsePaise(
            cell(row, "lifetime_value_paise", "customers.csv"),
            "lifetime_value_paise",
          ),
          tier: toCustomerTier(cell(row, "tier", "customers.csv")),
          doNotContactUntil: dnc,
          suppressionReason: reason === "" ? null : toSuppressionReason(reason),
        };
      }),
    }),
  );
  console.log(`  customers          ${customerRows.length}`);

  // ---- 4. Products --------------------------------------------------------
  await prisma.product.createMany({
    data: productRows.map((row) => ({
      merchantId: merchant.id,
      sourceRef: cell(row, "product_id", "products.csv"),
      name: cell(row, "name", "products.csv"),
      category: toProductCategory(cell(row, "category", "products.csv")),
      pricePaise: parsePaise(cell(row, "price_paise", "products.csv"), "price_paise"),
      currency: cell(row, "currency", "products.csv"),
      isActive: cell(row, "is_active", "products.csv") === "true",
    })),
  });
  console.log(`  products           ${productRows.length}`);

  // ---- Source-ref -> database-id maps -------------------------------------
  // Source refs are preserved on every row for traceability, but relations use
  // cuid primary keys, so real Razorpay data can land in the same tables later.
  const customerIds = new Map(
    (
      await prisma.customer.findMany({
        where: { merchantId: merchant.id },
        select: { id: true, sourceRef: true },
      })
    ).map((c) => [c.sourceRef, c.id]),
  );
  const productIds = new Map(
    (
      await prisma.product.findMany({
        where: { merchantId: merchant.id },
        select: { id: true, sourceRef: true },
      })
    ).map((p) => [p.sourceRef, p.id]),
  );

  function customerId(sourceRef: string): string {
    const id = customerIds.get(sourceRef);
    if (!id) throw new Error(`Unresolved customer reference: ${sourceRef}`);
    return id;
  }
  function productId(sourceRef: string): string {
    const id = productIds.get(sourceRef);
    if (!id) throw new Error(`Unresolved product reference: ${sourceRef}`);
    return id;
  }

  // ---- 5. Transactions ----------------------------------------------------
  await chunked(transactionRows, (batch) =>
    prisma.transaction.createMany({
      data: batch.map((row) => ({
        merchantId: merchant.id,
        sourceRef: cell(row, "transaction_id", "transactions.csv"),
        customerId: customerId(cell(row, "customer_id", "transactions.csv")),
        productId: productId(cell(row, "product_id", "transactions.csv")),
        quantity: Number(cell(row, "quantity", "transactions.csv")),
        amountPaise: parsePaise(
          cell(row, "amount_paise", "transactions.csv"),
          "amount_paise",
        ),
        currency: cell(row, "currency", "transactions.csv"),
        status: toTransactionStatus(cell(row, "status", "transactions.csv")),
        method: toPaymentMethod(cell(row, "method", "transactions.csv")),
        attemptCount: Number(cell(row, "attempt_count", "transactions.csv")),
        occurredAt: parseTimestamp(
          cell(row, "created_at", "transactions.csv"),
          "transaction.created_at",
        ),
        settledAt: parseTimestamp(
          cell(row, "updated_at", "transactions.csv"),
          "transaction.updated_at",
        ),
        refundedAt: parseOptionalTimestamp(
          cell(row, "refunded_at", "transactions.csv"),
          "refunded_at",
        ),
      })),
    }),
  );
  console.log(`  transactions       ${transactionRows.length}`);

  const transactionIds = new Map(
    (
      await prisma.transaction.findMany({
        where: { merchantId: merchant.id },
        select: { id: true, sourceRef: true },
      })
    ).map((t) => [t.sourceRef, t.id]),
  );
  function transactionId(sourceRef: string): string {
    const id = transactionIds.get(sourceRef);
    if (!id) throw new Error(`Unresolved transaction reference: ${sourceRef}`);
    return id;
  }

  // ---- 6. Payment attempts ------------------------------------------------
  // `retryOfAttemptId` is a self-reference, and a CHECK constraint requires it
  // on every attempt after the first. So ids are generated up front rather than
  // by the database: that lets the chain be linked in the same INSERT, with the
  // constraint fully armed, instead of inserting broken rows and patching them.
  //
  // Rows are sorted by source ref, which is allocated in chain order, so a
  // parent is always inserted in the same batch as its child or an earlier one.
  const sortedAttempts = [...attemptRows].sort((a, b) =>
    cell(a, "attempt_id", "payment_attempts.csv").localeCompare(
      cell(b, "attempt_id", "payment_attempts.csv"),
    ),
  );

  const attemptIds = new Map<string, string>();
  for (const row of sortedAttempts) {
    attemptIds.set(cell(row, "attempt_id", "payment_attempts.csv"), createId());
  }
  function attemptId(sourceRef: string): string {
    const id = attemptIds.get(sourceRef);
    if (!id) throw new Error(`Unresolved attempt reference: ${sourceRef}`);
    return id;
  }

  let retryLinkCount = 0;
  await chunked(sortedAttempts, (batch) =>
    prisma.paymentAttempt.createMany({
      data: batch.map((row) => {
        const status = toAttemptStatus(cell(row, "status", "payment_attempts.csv"));
        const reason = cell(row, "failure_reason", "payment_attempts.csv");
        const gatewayRef = cell(row, "gateway_ref", "payment_attempts.csv");
        const parentRef = cell(row, "retry_of_attempt_id", "payment_attempts.csv");
        if (parentRef !== "") retryLinkCount += 1;
        return {
          id: attemptId(cell(row, "attempt_id", "payment_attempts.csv")),
          merchantId: merchant.id,
          sourceRef: cell(row, "attempt_id", "payment_attempts.csv"),
          transactionId: transactionId(
            cell(row, "transaction_id", "payment_attempts.csv"),
          ),
          customerId: customerId(cell(row, "customer_id", "payment_attempts.csv")),
          amountPaise: parsePaise(
            cell(row, "amount_paise", "payment_attempts.csv"),
            "amount_paise",
          ),
          currency: cell(row, "currency", "payment_attempts.csv"),
          status,
          failureReason: reason === "" ? null : toFailureReason(reason),
          method: toPaymentMethod(cell(row, "method", "payment_attempts.csv")),
          attemptNo: Number(cell(row, "attempt_no", "payment_attempts.csv")),
          retryOfAttemptId: parentRef === "" ? null : attemptId(parentRef),
          gatewayRef: gatewayRef === "" ? null : gatewayRef,
          occurredAt: parseTimestamp(
            cell(row, "created_at", "payment_attempts.csv"),
            "attempt.created_at",
          ),
        };
      }),
    }),
  );
  console.log(
    `  payment attempts   ${attemptRows.length} (${retryLinkCount} retry links)`,
  );

  // ---- 7. Playbooks -------------------------------------------------------
  await prisma.playbook.createMany({
    data: config.playbooks.map((p) => ({
      merchantId: merchant.id,
      key: p.key,
      name: p.name,
      actionType: toPlaybookActionType(p.action_type),
      defaultDiscountBps: p.default_discount_bps,
      channelCostPaise: p.channel_cost_paise,
      isActive: true,
    })),
  });
  const playbookIds = new Map(
    (
      await prisma.playbook.findMany({
        where: { merchantId: merchant.id },
        select: { id: true, key: true },
      })
    ).map((p) => [p.key, p.id]),
  );
  console.log(`  playbooks          ${config.playbooks.length}`);

  // ---- 8. Guardrail policy v1 ---------------------------------------------
  await prisma.guardrailPolicy.create({
    data: {
      merchantId: merchant.id,
      version: config.guardrail_policy.policy_version,
      rules: config.guardrail_policy.rules as Prisma.InputJsonObject,
      isActive: true,
      updatedById: admin.id,
    },
  });
  console.log(
    `  guardrail policy   v${config.guardrail_policy.policy_version} ` +
      `(${Object.keys(config.guardrail_policy.rules).length} rules, active)`,
  );

  // ---- 9. Playbook priors -------------------------------------------------
  // Starting beliefs, not observations. seeded* is preserved unchanged so the
  // LEARN step's movement away from the prior stays visible in the UI.
  await prisma.playbookStat.createMany({
    data: config.playbook_priors.map((prior) => {
      const playbookId = playbookIds.get(prior.playbook_key);
      if (!playbookId) {
        throw new Error(`Prior references unknown playbook: ${prior.playbook_key}`);
      }
      const alphaMilli = toMilli(prior.alpha);
      const betaMilli = toMilli(prior.beta);
      return {
        merchantId: merchant.id,
        playbookId,
        failureReason: toFailureReason(prior.failure_reason),
        tierScope: "ALL" as const,
        alphaMilli,
        betaMilli,
        seededAlphaMilli: alphaMilli,
        seededBetaMilli: betaMilli,
        observationCount: 0,
      };
    }),
  });
  console.log(`  playbook priors    ${config.playbook_priors.length}`);

  console.log(
    `\nSeed complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. ` +
      "No opportunities computed — the database holds source of truth only.",
  );
}

main()
  .catch((error) => {
    console.error("\nSeed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
