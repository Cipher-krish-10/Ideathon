/**
 * Database validation.
 *
 * Verifies that the seeded database faithfully represents the APPROVED dataset,
 * by comparing live queries against data/dataset_summary.json — the same
 * baseline the Python validator uses. If the database and the dataset ever
 * disagree, that is the finding.
 *
 * Deliberately standalone: it constructs its own Prisma client rather than
 * going through the repository layer, so it validates the DATABASE rather than
 * the application's view of it.
 *
 *   npm run db:validate
 */
import fs from "node:fs";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { datasetSummarySchema, merchantConfigSchema } from "../src/server/dataset/config.js";

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DATA_DIR = path.join(process.cwd(), "data");
const readJson = <T,>(file: string, schema: { parse: (v: unknown) => T }): T =>
  schema.parse(JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")));

const failures: string[] = [];
let checksRun = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checksRun += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  check(label, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

/** Every raw-SQL integrity probe returns rows only when something is wrong. */
async function expectNoRows(label: string, query: Promise<Array<unknown>>): Promise<void> {
  const rows = await query;
  check(label, rows.length === 0, `${rows.length} offending row(s)`);
}

async function main() {
  const summary = readJson("dataset_summary.json", datasetSummarySchema);
  const config = readJson("merchant_config.json", merchantConfigSchema);

  // ---- Merchant and tenancy ------------------------------------------------
  const merchant = await prisma.merchant.findUnique({
    where: { sourceRef: config.merchant.merchant_id },
  });
  if (!merchant) {
    console.error(`FAILED: merchant "${config.merchant.merchant_id}" not found. Run: npm run db:seed`);
    process.exitCode = 1;
    return;
  }
  const merchantId = merchant.id;
  check("merchant: mode is TEST", merchant.mode === "TEST", merchant.mode);
  expectEqual("merchant: dataset seed recorded", merchant.datasetSeed, summary.generated_with.seed);
  check(
    "merchant: reference date recorded",
    merchant.datasetReferenceAt.toISOString() ===
      new Date(config.dataset.reference_datetime).toISOString(),
  );

  const where = { merchantId };

  // ---- Row counts ----------------------------------------------------------
  const rc = summary.row_counts;
  expectEqual("counts: customers", await prisma.customer.count({ where }), rc.customers);
  expectEqual("counts: products", await prisma.product.count({ where }), rc.products);
  expectEqual("counts: transactions", await prisma.transaction.count({ where }), rc.transactions);
  expectEqual("counts: payment attempts", await prisma.paymentAttempt.count({ where }), rc.payment_attempts);
  expectEqual(
    "counts: failed attempts",
    await prisma.paymentAttempt.count({ where: { ...where, status: "FAILED" } }),
    rc.failed_payment_attempts,
  );
  expectEqual(
    "counts: successful attempts",
    await prisma.paymentAttempt.count({ where: { ...where, status: "SUCCESS" } }),
    rc.successful_payment_attempts,
  );

  // ---- Money totals --------------------------------------------------------
  // Postgres SUM over INTEGER returns BIGINT, so these aggregates cannot
  // overflow the per-column paise ceiling.
  const money = summary.money_paise;
  const sumFor = async (status?: "CAPTURED" | "FAILED" | "REFUNDED") => {
    const result = await prisma.transaction.aggregate({
      where: status ? { ...where, status } : where,
      _sum: { amountPaise: true },
    });
    return result._sum.amountPaise ?? 0;
  };
  expectEqual("money: total transaction value", await sumFor(), money.total_transaction_value);
  expectEqual("money: captured revenue", await sumFor("CAPTURED"), money.captured_revenue);
  expectEqual("money: refunded value", await sumFor("REFUNDED"), money.refunded_value);
  expectEqual("money: failed payment value", await sumFor("FAILED"), money.failed_payment_value);

  // ---- Money representation is structural, not incidental -------------------
  // Assert at the SCHEMA level that every paise column really is an integer.
  const paiseColumns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name LIKE '%Paise'`;
  check("money: paise columns exist", paiseColumns.length > 0, `${paiseColumns.length} found`);
  const nonInteger = paiseColumns.filter((c) => c.data_type !== "integer");
  check(
    "money: every *Paise column is INTEGER (no float, no numeric)",
    nonInteger.length === 0,
    nonInteger.map((c) => `${c.table_name}.${c.column_name}=${c.data_type}`).join(", "),
  );
  const floatColumns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('double precision', 'real', 'numeric')`;
  check(
    "money: no floating-point column anywhere in the schema",
    floatColumns.length === 0,
    floatColumns.map((c) => `${c.table_name}.${c.column_name}`).join(", "),
  );

  // ---- Distributions -------------------------------------------------------
  const tierRows = await prisma.customer.groupBy({
    by: ["tier"], where, _count: { _all: true },
  });
  for (const [tier, expected] of Object.entries(summary.customers.tier_distribution)) {
    const actual = tierRows.find((r) => r.tier === tier)?._count._all ?? 0;
    expectEqual(`distribution: customers tier ${tier}`, actual, expected);
  }

  const statusRows = await prisma.transaction.groupBy({
    by: ["status"], where, _count: { _all: true },
  });
  for (const [status, expected] of Object.entries(summary.transactions.status_distribution)) {
    const actual = statusRows.find((r) => r.status === status)?._count._all ?? 0;
    expectEqual(`distribution: transactions ${status}`, actual, expected);
  }

  const reasonRows = await prisma.paymentAttempt.groupBy({
    by: ["failureReason"], where: { ...where, status: "FAILED" }, _count: { _all: true },
  });
  const reasonToEnum: Record<string, string> = {
    insufficient_funds: "INSUFFICIENT_FUNDS",
    payment_network_error: "PAYMENT_NETWORK_ERROR",
    authentication_failed: "AUTHENTICATION_FAILED",
    payment_method_declined: "PAYMENT_METHOD_DECLINED",
    expired_card: "EXPIRED_CARD",
    suspected_fraud: "SUSPECTED_FRAUD",
    unknown: "UNKNOWN",
  };
  for (const [reason, expected] of Object.entries(summary.failure_reason_distribution)) {
    const enumName = reasonToEnum[reason];
    const actual = reasonRows.find((r) => r.failureReason === enumName)?._count._all ?? 0;
    expectEqual(`distribution: failure reason ${reason}`, actual, expected);
  }

  // ---- Customer-level aggregates -------------------------------------------
  const withFailure = await prisma.customer.count({
    where: { ...where, paymentAttempts: { some: { status: "FAILED" } } },
  });
  expectEqual("customers: with at least one failed payment", withFailure, summary.customers.with_failed_payment);

  const referenceAt = merchant.datasetReferenceAt;
  expectEqual(
    "customers: actively suppressed as of reference date",
    await prisma.customer.count({ where: { ...where, doNotContactUntil: { gt: referenceAt } } }),
    summary.customers.actively_suppressed,
  );
  expectEqual(
    "customers: expired suppression as of reference date",
    await prisma.customer.count({ where: { ...where, doNotContactUntil: { lte: referenceAt } } }),
    summary.customers.expired_suppression,
  );

  expectEqual(
    "transactions: multi-attempt count",
    await prisma.transaction.count({ where: { ...where, attemptCount: { gt: 1 } } }),
    summary.transactions.multi_attempt_transactions,
  );

  // ---- Foreign keys resolve -------------------------------------------------
  await expectNoRows("fk: every transaction resolves its customer", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
      LEFT JOIN "customer" c ON c."id" = t."customerId" WHERE c."id" IS NULL`);
  await expectNoRows("fk: every transaction resolves its product", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
      LEFT JOIN "product" p ON p."id" = t."productId" WHERE p."id" IS NULL`);
  await expectNoRows("fk: every attempt resolves its transaction", prisma.$queryRaw`
    SELECT a."id" FROM "payment_attempt" a
      LEFT JOIN "transaction" t ON t."id" = a."transactionId" WHERE t."id" IS NULL`);
  await expectNoRows("fk: every attempt resolves its customer", prisma.$queryRaw`
    SELECT a."id" FROM "payment_attempt" a
      LEFT JOIN "customer" c ON c."id" = a."customerId" WHERE c."id" IS NULL`);
  await expectNoRows("fk: every retry link resolves its parent", prisma.$queryRaw`
    SELECT a."id" FROM "payment_attempt" a
      LEFT JOIN "payment_attempt" p ON p."id" = a."retryOfAttemptId"
     WHERE a."retryOfAttemptId" IS NOT NULL AND p."id" IS NULL`);

  // ---- Merchant scoping -----------------------------------------------------
  for (const table of [
    "customer", "product", "transaction", "payment_attempt",
    "playbook", "playbook_stat", "guardrail_policy", "user",
  ]) {
    await expectNoRows(
      `scoping: ${table} rows all belong to the demo merchant`,
      prisma.$queryRawUnsafe(
        `SELECT "id" FROM "${table}" WHERE "merchantId" IS DISTINCT FROM $1`,
        merchantId,
      ) as Promise<Array<unknown>>,
    );
  }
  // An attempt must never point at a transaction owned by another merchant.
  await expectNoRows("scoping: attempts never cross a merchant boundary", prisma.$queryRaw`
    SELECT a."id" FROM "payment_attempt" a
      JOIN "transaction" t ON t."id" = a."transactionId"
     WHERE t."merchantId" <> a."merchantId"`);
  await expectNoRows("scoping: transactions never cross a merchant boundary", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
      JOIN "customer" c ON c."id" = t."customerId"
     WHERE c."merchantId" <> t."merchantId"`);

  // ---- Transaction <-> attempt relationships --------------------------------
  await expectNoRows("chains: attemptCount matches the real chain length", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
      LEFT JOIN (
        SELECT "transactionId", COUNT(*) AS n FROM "payment_attempt" GROUP BY "transactionId"
      ) a ON a."transactionId" = t."id"
     WHERE COALESCE(a.n, 0) <> t."attemptCount"`);

  await expectNoRows("chains: every transaction has at least one attempt", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
     WHERE NOT EXISTS (SELECT 1 FROM "payment_attempt" a WHERE a."transactionId" = t."id")`);

  await expectNoRows("chains: at most one SUCCESS per transaction", prisma.$queryRaw`
    SELECT "transactionId" FROM "payment_attempt" WHERE "status" = 'SUCCESS'
     GROUP BY "transactionId" HAVING COUNT(*) > 1`);

  await expectNoRows("chains: a SUCCESS is always the terminal attempt", prisma.$queryRaw`
    SELECT s."id" FROM "payment_attempt" s
     WHERE s."status" = 'SUCCESS'
       AND EXISTS (
         SELECT 1 FROM "payment_attempt" l
          WHERE l."transactionId" = s."transactionId" AND l."attemptNo" > s."attemptNo")`);

  await expectNoRows("chains: status agrees with the attempt chain", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
     WHERE (
       EXISTS (SELECT 1 FROM "payment_attempt" a
                WHERE a."transactionId" = t."id" AND a."status" = 'SUCCESS')
       AND t."status" NOT IN ('CAPTURED', 'REFUNDED')
     ) OR (
       NOT EXISTS (SELECT 1 FROM "payment_attempt" a
                    WHERE a."transactionId" = t."id" AND a."status" = 'SUCCESS')
       AND t."status" <> 'FAILED'
     )`);

  await expectNoRows("chains: attempt numbering is contiguous from 1", prisma.$queryRaw`
    SELECT "transactionId" FROM "payment_attempt"
     GROUP BY "transactionId"
    HAVING MIN("attemptNo") <> 1
        OR MAX("attemptNo") <> COUNT(*)
        OR COUNT(DISTINCT "attemptNo") <> COUNT(*)`);

  await expectNoRows("chains: retry parent is the previous attempt, same transaction", prisma.$queryRaw`
    SELECT c."id" FROM "payment_attempt" c
      JOIN "payment_attempt" p ON p."id" = c."retryOfAttemptId"
     WHERE p."transactionId" <> c."transactionId"
        OR p."attemptNo" <> c."attemptNo" - 1`);

  await expectNoRows("chains: retries never travel backwards in time", prisma.$queryRaw`
    SELECT c."id" FROM "payment_attempt" c
      JOIN "payment_attempt" p ON p."id" = c."retryOfAttemptId"
     WHERE c."occurredAt" < p."occurredAt"`);

  await expectNoRows("chains: attempt amount matches its transaction", prisma.$queryRaw`
    SELECT a."id" FROM "payment_attempt" a
      JOIN "transaction" t ON t."id" = a."transactionId"
     WHERE a."amountPaise" <> t."amountPaise"`);

  await expectNoRows("chains: transaction amount equals price x quantity", prisma.$queryRaw`
    SELECT t."id" FROM "transaction" t
      JOIN "product" p ON p."id" = t."productId"
     WHERE t."amountPaise" <> p."pricePaise" * t."quantity"`);

  // ---- Failure-reason integrity ---------------------------------------------
  await expectNoRows("reasons: FAILED implies a reason, SUCCESS implies none", prisma.$queryRaw`
    SELECT "id" FROM "payment_attempt"
     WHERE ("status" = 'FAILED' AND "failureReason" IS NULL)
        OR ("status" <> 'FAILED' AND "failureReason" IS NOT NULL)`);

  // ---- Configuration seeded -------------------------------------------------
  const playbooks = await prisma.playbook.findMany({ where, orderBy: { key: "asc" } });
  expectEqual("config: playbook count", playbooks.length, config.playbooks.length);
  for (const expected of config.playbooks) {
    const found = playbooks.find((p) => p.key === expected.key);
    check(`config: playbook ${expected.key} exists`, Boolean(found));
    if (found) {
      expectEqual(`config: playbook ${expected.key} discount bps`, found.defaultDiscountBps, expected.default_discount_bps);
      expectEqual(`config: playbook ${expected.key} channel cost`, found.channelCostPaise, expected.channel_cost_paise);
    }
  }

  const policies = await prisma.guardrailPolicy.findMany({ where, orderBy: { version: "asc" } });
  expectEqual("config: exactly one guardrail policy", policies.length, 1);
  const policy = policies[0];
  if (policy) {
    expectEqual("config: guardrail policy is v1", policy.version, config.guardrail_policy.policy_version);
    check("config: guardrail policy v1 is active", policy.isActive);
    const ruleKeys = Object.keys(policy.rules as Record<string, unknown>).sort();
    const expectedKeys = Object.keys(config.guardrail_policy.rules).sort();
    check(
      "config: all guardrail rules present",
      JSON.stringify(ruleKeys) === JSON.stringify(expectedKeys),
      `db=${ruleKeys.length} config=${expectedKeys.length}`,
    );
  }

  const stats = await prisma.playbookStat.findMany({ where });
  expectEqual("config: playbook priors seeded", stats.length, config.playbook_priors.length);
  check(
    "config: priors start unmodified (alpha == seededAlpha)",
    stats.every((s) => s.alphaMilli === s.seededAlphaMilli && s.betaMilli === s.seededBetaMilli),
  );
  check("config: priors start with zero observations", stats.every((s) => s.observationCount === 0));
  await expectNoRows("config: every prior resolves its playbook", prisma.$queryRaw`
    SELECT s."id" FROM "playbook_stat" s
      LEFT JOIN "playbook" p ON p."id" = s."playbookId" WHERE p."id" IS NULL`);

  const users = await prisma.user.findMany({ where, orderBy: { role: "asc" } });
  check("config: an ADMIN user exists", users.some((u) => u.role === "ADMIN"));
  check("config: an APPROVER user exists", users.some((u) => u.role === "APPROVER"));

  // ---- Source traceability --------------------------------------------------
  for (const [label, count] of [
    ["customer", await prisma.customer.count({ where: { ...where, sourceRef: { startsWith: "cust_" } } })],
    ["product", await prisma.product.count({ where: { ...where, sourceRef: { startsWith: "prod_" } } })],
    ["transaction", await prisma.transaction.count({ where: { ...where, sourceRef: { startsWith: "txn_" } } })],
    ["payment attempt", await prisma.paymentAttempt.count({ where: { ...where, sourceRef: { startsWith: "pa_" } } })],
  ] as const) {
    const total =
      label === "customer" ? rc.customers
      : label === "product" ? rc.products
      : label === "transaction" ? rc.transactions
      : rc.payment_attempts;
    expectEqual(`traceability: every ${label} keeps its dataset sourceRef`, count, total);
  }

  // ---- The seed writes source of truth only ---------------------------------
  // Phases beyond the seed legitimately add rows here, so these checks assert
  // PROVENANCE rather than emptiness: nothing derived may exist that a detector
  // run cannot account for.
  const opportunities = await prisma.opportunity.findMany({ where });
  check(
    "source-of-truth only: every opportunity was produced by a detector run",
    opportunities.every((o) => Boolean(o.detectorKey) && Boolean(o.detectorVersion)),
    `${opportunities.filter((o) => !o.detectorKey || !o.detectorVersion).length} without provenance`,
  );
  await expectNoRows("integrity: every opportunity target resolves its opportunity", prisma.$queryRaw`
    SELECT t."id" FROM "opportunity_target" t
      LEFT JOIN "opportunity" o ON o."id" = t."opportunityId" WHERE o."id" IS NULL`);
  await expectNoRows("integrity: opportunity targets never cross a merchant boundary", prisma.$queryRaw`
    SELECT t."id" FROM "opportunity_target" t
      JOIN "opportunity" o ON o."id" = t."opportunityId"
      JOIN "transaction" x ON x."id" = t."transactionId"
     WHERE x."merchantId" <> o."merchantId"`);
  await expectNoRows("integrity: opportunity target amounts are positive integers", prisma.$queryRaw`
    SELECT "id" FROM "opportunity_target" WHERE "recoverableAmountPaise" <= 0`);

  // Estimates are produced by the estimator, so this too is a provenance check:
  // every row must be stamped with the version that scored it, and its
  // arithmetic must add up independently of the CHECK constraints.
  const estimates = await prisma.estimate.findMany({ where });
  check(
    "source-of-truth only: every estimate records its estimator version",
    estimates.every((e) => Boolean(e.estimatorVersion)),
    `${estimates.filter((e) => !e.estimatorVersion).length} without provenance`,
  );
  check(
    "integrity: expectedNet equals gross minus cost on every estimate",
    estimates.every((e) => e.expectedNetPaise === e.expectedGrossPaise - e.costPaise),
  );
  check(
    "integrity: cost equals discount + channel + gateway fee on every estimate",
    estimates.every(
      (e) => e.costPaise === e.discountCostPaise + e.channelCostPaise + e.gatewayFeePaise,
    ),
  );
  check(
    "integrity: every estimate probability is within 0..10000 bps",
    estimates.every((e) => e.pRecoverAvgBps >= 0 && e.pRecoverAvgBps <= 10_000),
  );
  check(
    "integrity: every estimate carries a deterministic inputs snapshot",
    estimates.every((e) => {
      const snapshot = e.inputsSnapshot as Record<string, unknown> | null;
      return Boolean(snapshot && snapshot.targets && snapshot.config);
    }),
  );
  await expectNoRows("integrity: every estimate resolves its opportunity", prisma.$queryRaw`
    SELECT e."id" FROM "estimate" e
      LEFT JOIN "opportunity" o ON o."id" = e."opportunityId" WHERE o."id" IS NULL`);

  // These belong to phases that do not exist yet. A non-zero count would mean
  // something wrote a money action before it was built.
  for (const [label, count] of [
    ["interventions", await prisma.intervention.count({ where })],
    ["approvals", await prisma.approval.count({ where })],
    ["execution attempts", await prisma.executionAttempt.count({ where })],
    ["attribution records", await prisma.attributionRecord.count({ where })],
  ] as const) {
    expectEqual(`not yet implemented: no ${label} exist`, count, 0);
  }

  // ---- Report ---------------------------------------------------------------
  console.log(`checks run: ${checksRun}`);
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length}`);
    for (const failure of failures) console.log(`  x ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("all checks passed");

  const fmt = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  console.log("\n-- database matches data/dataset_summary.json --");
  console.log(`  merchant           ${merchant.name} [${merchant.mode}]`);
  console.log(`  customers          ${rc.customers}`);
  console.log(`  products           ${rc.products}`);
  console.log(`  transactions       ${rc.transactions}  (CAPTURED ${summary.transactions.status_distribution.CAPTURED}, FAILED ${summary.transactions.status_distribution.FAILED}, REFUNDED ${summary.transactions.status_distribution.REFUNDED})`);
  console.log(`  payment attempts   ${rc.payment_attempts}  (${rc.failed_payment_attempts} failed)`);
  console.log(`  captured revenue   ${fmt(money.captured_revenue)}`);
  console.log(`  failed value       ${fmt(money.failed_payment_value)}`);
  console.log(`  playbooks          ${playbooks.length} + ${stats.length} priors, guardrail policy v${policy?.version ?? "?"}`);
}

main()
  .catch((error) => {
    console.error("Validation crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
