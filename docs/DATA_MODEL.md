# RevenuePilot — Data Model

**Status:** Implemented. Migrated, seeded, validated (89 DB checks), and tested (65 tests).
**Scope:** The database foundation. No detector, estimator, LLM, guardrail engine, Razorpay integration, or UI.
**Applies to:** [`prisma/schema.prisma`](../prisma/schema.prisma), [`prisma/seed.ts`](../prisma/seed.ts), [`src/server/repositories/`](../src/server/repositories/), [`scripts/validate-db.ts`](../scripts/validate-db.ts)

---

## 1. Approved architecture amendments

Three changes to `ARCHITECTURE.md` §3 were approved before this phase and are implemented here.

| Amendment | Rationale |
|---|---|
| **`Product` is a first-class model** | §3 had no product table. Without real price dispersion (₹149–₹89,999) the value floors are untestable, and category analysis has nothing to group by. |
| **`PaymentAttempt` is a first-class model** | §3 buried attempts in `Transaction.raw`. Retry chains are the detector's primary evidence — they determine whether a transaction is still unpaid and which failure reason is operative. Evidence that central belongs in a queryable, indexed, constrained table, not in JSON. |
| **`LlmCall` deferred** | Listed in §3 but not required by this phase. It arrives in Phase 3, with the reasoner that populates it. Adding it now would be an unused table. |

---

## 2. Money representation

> **Every monetary value in RevenuePilot is an integer number of paise. There is not one floating-point column in the schema.**

### Why

RevenuePilot's entire claim is that its numbers are traceable and reproducible. IEEE-754 binary floating point cannot represent `0.1` exactly, so repeated rupee-scale arithmetic drifts. A demo that shows a different recovered total on the second run has lost the argument before anyone asks a question.

### How it is enforced

| Layer | Mechanism |
|---|---|
| **Schema** | Every monetary field is `Int`, named `…Paise`. Postgres type `integer`. |
| **Database** | `CHECK` constraints: amounts positive, costs non-negative, `expectedNetPaise = expectedGrossPaise − costPaise`, `costPaise = discount + channel + gatewayFee`. A figure that does not add up cannot be stored. |
| **Application** | [`src/lib/money.ts`](../src/lib/money.ts) exposes a branded `Paise` type. `paise()` rejects non-integers, negatives, and anything over the column ceiling. `rupeesToPaise()` rejects sub-paise precision rather than silently rounding. |
| **Validation** | `scripts/validate-db.ts` queries `information_schema` and asserts that every `%Paise` column is `integer`, **and that no `double precision`, `real`, or `numeric` column exists anywhere in the schema.** A future migration that introduces a float fails the build. |

### Rates and probabilities are integers too

A float adjacent to money leaks into money. So:

- **Discounts and fees** are **basis points** (`Int`, 0–10000). 10% is `1000`, never `0.1`. `applyBps()` rounds half-up to whole paise.
- **Recovery probability** is `pRecoverAvgBps` (`Int`, 0–10000), CHECK-constrained to range.
- **Beta priors** are stored as **milli-units**: `alphaMilli`, `betaMilli`. A prior of `18.8` is `18800`. The LEARN step increments integers, so updates stay exactly reproducible across runs.

### The Int32 ceiling — a documented limit

A paise column holds at most `2,147,483,647` — about **₹2.14 crore per row**.

- Comfortable for this dataset: largest transaction is ₹89,999 (8,999,900 paise), largest customer LTV ~₹2.8 lakh.
- **Aggregates are safe**: Postgres `SUM(integer)` returns `bigint`, so the ₹1.12 crore captured-revenue total (1,120,859,100 paise) is computed correctly even though it uses over half the per-column range.
- `sumPaise()` returns a plain `number`, not `Paise`, precisely because totals are *displayed*, not stored.
- If a merchant ever needs a single transaction above ₹2.14 crore, the migration is `Int` → `BigInt` on that column. Recorded here so it is a decision, not a surprise.

---

## 3. Models

### Identity and tenancy

| Model | Why it exists | Key points |
|---|---|---|
| **`Merchant`** | Tenant root and the anchor for every scoped query. | Carries `datasetReferenceAt` — the dataset's "as of" instant. **The detector must evaluate recency and suppression against this, not the wall clock**, or the demo stops being reproducible the day after it is generated. Also records `datasetSeed` and `datasetVersion` for traceability. `mode` defaults to `TEST`. |
| **`User`** | The approval gate is a role boundary, not a checkbox. | `VIEWER` / `APPROVER` / `ADMIN`. Unique `[merchantId, email]`. |
| **`Session`** | **Not implemented.** | The task allowed it "only if genuinely required at this stage". No auth is being built yet, so adding it would be an unused table. It arrives with the auth decision in Phase 0 of the UI work. |

### Source data — the immutable world the agent observes

| Model | Why it exists | Key points |
|---|---|---|
| **`Customer`** | Carries the two constraints that make guardrails real: value and consent. | `lifetimeValuePaise` feeds value floors and tier modifiers. `doNotContactUntil` is a **date, not a boolean** — an expired suppression does not suppress. CHECK: a suppression date and its reason travel together in both directions. |
| **`Product`** | Real price dispersion is what makes "too small to chase" testable. | `pricePaise > 0`. Category enum for later analysis. |
| **`Transaction`** | The order intent, and the unit an opportunity is counted in. | Status is reconciled **from** the attempt chain, never asserted independently. CHECK: `refundedAt` present exactly when status is `REFUNDED`. `occurredAt`/`settledAt` are *source* timestamps, distinct from `createdAt` (when we ingested). |
| **`PaymentAttempt`** | **The detector's primary evidence.** | The chain determines whether a transaction is still unpaid; its final `FAILED` entry determines the operative failure reason. Self-referencing `retryOfAttemptId` forms the chain. Unique `[transactionId, attemptNo]` and unique `retryOfAttemptId` (a parent has at most one retry). |

### Agent domain

| Model | Why it exists | Key points |
|---|---|---|
| **`Opportunity`** | Detector output. | Carries **observed facts only** — `affectedCustomerCount`, `recoverableAmountPaise`, `evidence`. No probability, no projection. Records `referenceAt` so a run's "as of" is auditable. |
| **`OpportunityTarget`** | One qualifying transaction. | Points at `paymentAttemptId` — the *operative* failed attempt — not just the transaction, so the reasoning is inspectable. |
| **`Playbook`** | The candidate actions. | Three seeded from config. Discount in bps, CHECK-constrained 0–10000. |
| **`Estimate`** | Deterministic scoring of one (opportunity, playbook) pair. | Computed in TypeScript **before any LLM call**. `inputsSnapshot` records every input so the number is reproducible. CHECK constraints make the arithmetic unfalsifiable. `expectedNetPaise` may be negative — `MIN_EXPECTED_NET` blocks those at the guardrail layer, not here. |

### Decision and action

| Model | Why it exists | Key points |
|---|---|---|
| **`Intervention`** | The unit of agent action, and the state machine's subject. | `version` is an optimistic lock so two approvers cannot both advance it. `attributionRef` is **globally** unique — it travels outside our database, embedded in payment links. `reasoningMode` records whether the LLM or the deterministic fallback produced the proposal, so a degraded run is never silent. |
| **`InterventionTarget`** | One customer within an intervention. | `perTargetRef` globally unique, so a multi-customer action still attributes each payment to the right person. |
| **`GuardrailPolicy`** | Versioned, never mutated. | Editing creates a new version. Unique `[merchantId, version]`. |
| **`GuardrailEvaluation`** | One row per (intervention, phase). | `PRE_APPROVAL` is shown to the merchant; `PRE_EXECUTION` re-runs the same rules against fresh state immediately before the provider call. `ruleResults` holds observed-vs-limit per rule so the UI can explain the outcome. |
| **`Approval`** | The human gate. | `interventionId` is **unique**: one decisive decision per intervention. `interventionVersion` records which version was approved. |
| **`ExecutionAttempt`** | One provider call. | `idempotencyKey` globally unique, persisted **before** the call is issued, so a crash between issue and response cannot double-act. |
| **`RazorpayArtifact`** | What the provider created. | Unique `[merchantId, providerEntityId]`. Field named `providerEntityId`, not a Razorpay-specific name, because the adapter is an anti-corruption layer. |

### Outcome

| Model | Why it exists | Key points |
|---|---|---|
| **`WebhookEvent`** | Raw provider event, stored verbatim before any processing. | `providerEventId` globally unique — this is the dedupe key. `merchantId` is **nullable**: an event may arrive before we can resolve its merchant, and dropping it would be worse than storing it unattributed. |
| **`AttributionRecord`** | Links a payment back to the intervention that caused it. | Unique `[interventionId, transactionId]` — a transaction is credited at most once. **Absence of a row means UNATTRIBUTED**, which is a valid, visible outcome, never a silent guess. |
| **`PlaybookStat`** | Beta priors, and where LEARN writes. | `seededAlphaMilli`/`seededBetaMilli` are set once and never overwritten, so movement away from the prior stays visible in the UI. `tierScope` uses an `ALL` sentinel rather than NULL, because Postgres treats NULLs as distinct in unique constraints. |
| **`AuditLog`** | Append-only, hash-chained. | `seq` monotonic per merchant. `hash` covers `prevHash`, so a retroactive edit breaks verification for every later row. CHECK: both hashes are exactly 64 chars. |

---

## 4. Invariants enforced in the database

Application code can be bypassed — by a script, a migration, a console, a bug. These cannot.

### The approval gate — the product's central safety promise

Two triggers, in [`prisma/migrations/20260905224500_integrity_constraints_and_triggers/migration.sql`](../prisma/migrations/20260905224500_integrity_constraints_and_triggers/migration.sql):

1. **`intervention_require_approval`** — an `Intervention` cannot enter `EXECUTING`, `EXECUTED`, `EXECUTION_FAILED`, `OBSERVING`, `CONVERTED`, `NOT_CONVERTED`, or `LEARNED` unless an `Approval` row with `decision = APPROVED` exists.
2. **`execution_attempt_require_approval`** — an `ExecutionAttempt` cannot be inserted for an unapproved intervention.

A `REJECTED` decision counts as no approval at all. Both are covered by tests, including the negative cases.

### Append-only audit

**`audit_log_append_only`** rejects `UPDATE` unconditionally. `DELETE` is rejected unless a session opts in explicitly:

```sql
SET LOCAL revenuepilot.allow_audit_purge = 'on';
```

That opt-in is the design, not a loophole: teardown and demo resets remain possible, but never accidental, and the escape hatch is visible in the code that uses it.

### Structural CHECK constraints

Money positive · costs non-negative · `net = gross − cost` · `cost = discount + channel + fee` · bps in 0–10000 · `FAILED` implies a reason and `SUCCESS` implies none · `attemptNo = 1` implies no retry parent and `attemptNo > 1` requires one · no self-retry · `refundedAt` iff `REFUNDED` · suppression date and reason paired · `lifetimeValue ≥ historicalValue` · audit hashes exactly 64 chars.

> The retry-link constraint caught a real defect during this phase. The seed's first implementation inserted attempts with a null parent and patched the chain in a second pass; the constraint rejected it. The fix was to pre-generate IDs and link the chain in a single insert **with the constraint fully armed** — rather than weakening a correct constraint to suit a convenient insert strategy.

### Deletion behaviour, explicitly

| Relation | Behaviour | Reason |
|---|---|---|
| `Merchant` → everything | `Cascade` | Demo teardown is one operation. |
| `Transaction` → `PaymentAttempt` | `Cascade` | Attempts are part of the transaction aggregate. |
| `Customer`/`Product` → `Transaction` | `Restrict` | Never silently lose financial records. |
| `PaymentAttempt` → `retryOf` | `Restrict` | Chain integrity. |
| `Estimate`/`Playbook` → `Intervention` | `Restrict` | An intervention must always be able to explain itself. |
| `Intervention` → approvals, evaluations, attempts, artifacts, attributions | `Cascade` | They have no meaning without it. |
| `ExecutionAttempt` → `RazorpayArtifact` | `SetNull` | The artifact outlives the attempt that created it. |

Every relation in the schema declares both `onDelete` and `onUpdate`.

---

## 5. Tenant scoping

Every merchant-owned table carries `merchantId`, indexed, with natural keys unique **per merchant** — never globally. `cust_0001` legitimately exists for two different merchants and resolves to two different rows; there is a test for exactly that.

### Three layers

1. **`MerchantScope.where()`** merges the scope **after** any caller-supplied filter. `where({ merchantId: "someone-else" })` silently resolves to the scoped merchant rather than leaking another tenant's rows.
2. **`findFirst`, not `findUnique`**, for lookups by primary key. A foreign ID must resolve to `null`, not to the row. Tested.
3. **An ESLint boundary rule** forbids importing `@/server/db` or constructing a Prisma client outside `src/server/**`. A single unscoped `findMany` is a cross-tenant leak that looks like ordinary code in review, so it is enforced by the linter rather than by discipline. *(Verified: the rule was tested against a deliberate violation and fired.)*

The repository layer covers `Merchant`, `Customer`, `Product`, `Transaction`, and `PaymentAttempt`. `MerchantRepository` is intentionally unscoped — it is how a scope is obtained in the first place.

---

## 6. Dataset → database field mapping

The dataset is **immutable source data**. The seed transforms representation only — snake_case tokens to enums, ISO strings to `Date`. It never invents, derives, or adjusts a value.

### `customers.csv` → `Customer`

| CSV column | Database field | Transformation |
|---|---|---|
| `customer_id` | `sourceRef` | Preserved verbatim for traceability |
| `external_ref` | `externalRef` | — |
| `masked_email` / `masked_phone` | `maskedEmail` / `maskedPhone` | Already masked at generation; raw PII never exists |
| `city` | `city` | — |
| `signup_at` | `signupAt` | ISO 8601 → `DateTime` |
| `historical_value_paise` | `historicalValuePaise` | Integer paise, unchanged |
| `lifetime_value_paise` | `lifetimeValuePaise` | Integer paise, unchanged |
| `tier` | `tier` | `HIGH`/`MEDIUM`/`LOW` → `CustomerTier` |
| `do_not_contact_until` | `doNotContactUntil` | Empty string → `NULL` |
| `suppression_reason` | `suppressionReason` | `customer_opt_out` → `CUSTOMER_OPT_OUT` |

### `products.csv` → `Product`

`product_id` → `sourceRef` · `name` · `category` (`subscription` → `SUBSCRIPTION`) · `price_paise` → `pricePaise` · `currency` · `is_active` → `isActive` (string `"true"` → boolean).

### `transactions.csv` → `Transaction`

`transaction_id` → `sourceRef` · `customer_id`/`product_id` → resolved to cuid FKs via a source-ref map · `quantity` · `amount_paise` → `amountPaise` · `status` → `TransactionStatus` · `method` (`upi` → `UPI`) · `attempt_count` → `attemptCount` · **`created_at` → `occurredAt`** · **`updated_at` → `settledAt`** · `refunded_at` → `refundedAt` (empty → `NULL`).

> The source timestamps are renamed deliberately. `createdAt` on the row means *when we ingested it*; conflating the two would make ingestion time indistinguishable from business time.

### `payment_attempts.csv` → `PaymentAttempt`

`attempt_id` → `sourceRef` · `transaction_id`/`customer_id` → FKs · `amount_paise` → `amountPaise` · `status` → `AttemptStatus` · `failure_reason` → `FailureReason` (empty → `NULL`) · `method` · `attempt_no` → `attemptNo` · `retry_of_attempt_id` → `retryOfAttemptId` (resolved to pre-generated cuids) · `gateway_ref` → `gatewayRef` · **`created_at` → `occurredAt`**.

### `merchant_config.json`

| Config section | Destination |
|---|---|
| `merchant` | `Merchant` row |
| `dataset` | `Merchant.datasetReferenceAt` / `datasetSeed` / `datasetVersion` |
| `playbooks` | 3 `Playbook` rows |
| `guardrail_policy` | `GuardrailPolicy` v1, `isActive = true`, 10 rules as JSON |
| `playbook_priors` | 15 `PlaybookStat` rows, `alpha`×1000 → `alphaMilli` |
| `detector_config` | **Not seeded.** Read as configuration by the detector in Phase 2. Persisting the recoverable/non-recoverable classification as rows would be exactly the label leakage `DATASET_SPEC.md` forbids. |

### ID strategy

Primary keys are `cuid()`, not the dataset's identifiers, so real Razorpay data can land in the same tables later without a migration. Traceability comes from `sourceRef`, which is preserved on every row and unique per merchant. `validate-db.ts` asserts that all 500 customers, 1,200 transactions, and 1,223 attempts retain their dataset prefix.

**`PaymentAttempt` IDs are generated in application code**, not by the database. The self-referencing `retryOfAttemptId` plus the retry CHECK constraint means the chain must be linked in the same insert as the rows themselves.

---

## 7. Verification

| Gate | Command | Result |
|---|---|---|
| Type checking | `npm run typecheck` | clean (TypeScript strict, `noUncheckedIndexedAccess`) |
| Linting | `npm run lint` | clean, boundary rule verified against a deliberate violation |
| Tests | `npm test` | **65 passed** across 5 files |
| DB validation | `npm run db:validate` | **89 checks passed** |
| Dataset integrity | `python3 analytics/validate_dataset.py` | 107 checks passed, dataset unmodified |

`npm run verify` runs typecheck, lint, tests, and DB validation in sequence.

### What the tests cover

- **Money** (unit): integer enforcement, float-drift resistance, bps arithmetic, Indian digit grouping, ceiling behaviour.
- **Seed consistency**: every row count, every money total, and every distribution checked against `data/dataset_summary.json`; priors seeded unmodified; **agent tables empty** — if `Opportunity` or `Estimate` were non-zero, the seed would have started doing the detector's job.
- **Transaction ↔ attempt relationships**: `attemptCount` accuracy, status derived from the chain, one terminal `SUCCESS`, unbroken chronological retry chains, operative-reason semantics on a real multi-attempt transaction, cascade behaviour.
- **Merchant scoping**: scope cannot be overridden, foreign IDs resolve to `null`, the same `sourceRef` resolves per-merchant, aggregates are scoped, contactability is a date comparison.
- **Schema invariants**: no float columns anywhere, the approval gate in five variations (including `REJECTED` counting as unapproved), append-only audit, idempotency-key uniqueness, estimate arithmetic.

---

## 8. Phase 1 amendments — Revenue Detective

Two schema changes came out of implementing the detector. Both are recorded here
rather than in the detector's own notes, because they are data-model decisions.

**`Opportunity` gained a uniqueness key**
`@@unique([merchantId, detectorKey, detectorVersion, referenceAt])`. Re-running
the same detector version against the same reference instant must reuse one row,
never create a second. Enforcing it as an index rather than as a service-layer
check means a concurrent double-run conflicts loudly instead of silently
double-counting recoverable revenue.

**`OpportunityTarget` foreign keys moved from `Restrict` to `Cascade`**
The original `Restrict` on `customerId` / `transactionId` / `paymentAttemptId`
made a merchant permanently undeletable the moment a detector run produced
targets: the cascade from `Merchant` reached `customer` while a target still
referenced it. That guarantee was not worth keeping. A target is *derived* data —
a pointer into source records the detector can recompute from scratch at any
time — and the durable record of what the agent decided is the append-only,
hash-chained `AuditLog`, not this table.

> The same latent issue exists on `InterventionTarget` and `AttributionRecord`,
> whose `Restrict` FKs to `Customer`/`Transaction` will block teardown once those
> tables carry rows. Left alone for now because no phase populates them yet and a
> change there would be untested; it should be handled by the phase that does.

## 9. Phase 2 amendment — Estimator

**`Estimate` idempotency became version-aware**
`@@unique([opportunityId, playbookId])` became
`@@unique([opportunityId, playbookId, estimatorVersion])`. The old key meant a
new estimator version could not score an opportunity an older version had
already scored. Estimates are the audit trail behind a money decision, so a new
version must be able to score alongside the old one — an `Intervention` stays
explainable by the exact version that produced its numbers.

**Estimator calibration lives in `src/server/config/estimator-config.ts`**
`merchant_config.json` supplies base-rate priors, the gateway fee, discounts and
channel costs, but no recency/tier/incentive modifier tables. The dataset is
immutable, so those modifiers are declared as versioned configuration outside
`src/core` and passed into the pure estimator as explicit input. They are
plausible calibration constants, not measured effects, and should move into
merchant configuration when that file is next regenerated.

## 10. Deliberate omissions

Not built yet:

LLM reasoning and `LlmCall` · guardrail engine · approval UI · Razorpay adapter · webhook ingestion · attribution engine · audit hash-chain *writer* (the table and its immutability exist; the append helper arrives with the first thing that emits events) · authentication and `Session`.

## 11. Known limitations

- **`migrate reset` was not run.** Prisma 7 blocks destructive resets initiated by an AI agent without explicit user consent, which is correct behaviour. Both migrations were applied incrementally and `prisma migrate status` reports the database in sync; a from-scratch rebuild should be confirmed by a human running `npx prisma migrate reset --force`.
- **`Int` caps a single monetary column at ₹2.14 crore.** Fine for this dataset; documented in §2 with the `BigInt` migration path.
- **Tests share the development database.** `fileParallelism` is disabled and scratch merchants are purged in teardown. A dedicated test database is the right move once CI exists.
- **`FailureReason` is our taxonomy, not Razorpay's.** Provider error codes are mapped onto it in the adapter, in a later phase.
