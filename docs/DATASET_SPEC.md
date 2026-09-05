# RevenuePilot — Synthetic Dataset Specification

**Status:** Implemented. Generated, validated, and verified deterministic.
**Scope:** The simulated merchant environment for the MVP use case, **failed-payment recovery**.
**Applies to:** [`analytics/generate_dataset.py`](../analytics/generate_dataset.py), [`analytics/validate_dataset.py`](../analytics/validate_dataset.py), `data/*`

---

## 1. Purpose and boundary

This dataset is the **world the agent observes**. It is not the agent's output, and it must never contain the agent's conclusions.

**What it provides:** a believable small/medium Indian SaaS-and-services merchant with six months of trading history, containing failed payments that vary along every axis the detector must discriminate on.

**What it must never provide:**
- No `recoverable` / `should_target` / `is_opportunity` column.
- No pre-computed expected revenue, recovery probability, or intervention value.
- No post-agent financial results. Every rupee RevenuePilot reports is computed by the deterministic estimator from these raw records at runtime.

The dataset supplies **evidence**. The detector derives **conclusions**. A validator check (`no-leak`) fails the build if a banned column name ever appears in an application-facing file.

---

## 2. Design rules

| Rule | Implementation |
|---|---|
| **Money** | Every monetary field is an **integer number of paise**. Rupee-scale values exist only as internal generator parameters, converted through `rupees_to_paise()`. Display-only rupee figures in `dataset_summary.json` are suffixed `_rupees_display` so they cannot be mistaken for canonical values. |
| **Determinism** | Fixed `--seed`, fixed `--end-date` default, five independent RNG streams, all output sorted by primary key, `sort_keys=False` with fixed insertion order in JSON, `lineterminator="\n"`. No wall-clock reads anywhere. |
| **Time** | ISO 8601 with explicit `+05:30` offset. The dataset's "now" is `reference_date`, recorded in `merchant_config.json`. **The detector must evaluate recency and suppression against `reference_date`, not the wall clock** — otherwise the demo stops being reproducible the day after it is generated. |
| **Referential integrity** | Every FK resolves; attempt/transaction customer agreement is enforced; transaction amount always equals `price × quantity`; every attempt bills its transaction's exact amount. |
| **Derived-not-declared** | `lifetime_value`, `tier`, `transaction.status`, and `attempt_count` are all reconciled *from* the underlying records at the end of generation, so they can never contradict them. |

### Independent RNG streams

`seed+101` customers · `seed+202` products · `seed+303` organic history · `seed+404` cohorts · `seed+505` timestamps.

Adding a scenario cohort therefore does not reshuffle the organic population. Without this, every tuning change silently invalidates every previously verified number.

---

## 3. The merchant

**Nimbus Commerce Pvt Ltd** — an Indian SaaS-and-services business selling subscriptions, add-ons, professional services, courses, and a little hardware. Price points span ₹149 to ₹89,999, which is what makes the value floors meaningful: some failures are genuinely not worth chasing.

- Timezone `Asia/Kolkata`, currency `INR`, mode `TEST`.
- Window: **2026-03-02 → 2026-09-01** (183 days).
- All 500 customers pre-date the window. The window is the merchant's *recent* history, not its whole life, so `historical_value_paise` carries pre-window spend and no transaction can precede a signup.

---

## 4. Entities

### 4.1 `data/customers.csv` — 500 rows

| Column | Type | Notes |
|---|---|---|
| `customer_id` | string PK | `cust_0001` … |
| `external_ref` | string | merchant-side reference |
| `masked_email` | string | `ta*********@outlook.com` — masked at generation; raw PII never exists |
| `masked_phone` | string | `+91*****4820` |
| `city` | string | one of 10 Indian cities |
| `signup_at` | ISO 8601 | always before the window opens |
| `historical_value_paise` | int | pre-window spend |
| `lifetime_value_paise` | int | `historical + in-window captured` — **reconciled, not invented** |
| `tier` | enum | `HIGH` / `MEDIUM` / `LOW`, derived from LTV thresholds |
| `do_not_contact_until` | ISO 8601 or empty | raw suppression state |
| `suppression_reason` | enum or empty | `customer_opt_out` / `chargeback_dispute` / `support_escalation` |

Tier thresholds (in `merchant_config.json`, not hard-coded in the detector): `HIGH ≥ ₹50,000`, `MEDIUM ≥ ₹10,000`, else `LOW`.

`do_not_contact_until` is a **date, not a boolean**. Nine customers carry an *expired* suppression, so a detector that merely checks for presence rather than comparing against `reference_date` will over-exclude and fail validation.

### 4.2 `data/products.csv` — 18 rows

`product_id` · `name` · `category` (`subscription` / `addon` / `service` / `course` / `merch` / `hardware`) · `price_paise` · `currency` · `is_active`.

### 4.3 `data/transactions.csv` — 1,200 rows

A transaction is an **order intent**, not a payment. Its status is reconciled from its attempt chain.

| Column | Notes |
|---|---|
| `transaction_id` PK | `txn_000001` … |
| `customer_id`, `product_id` | FK |
| `quantity`, `amount_paise` | `amount = price × quantity`, enforced |
| `status` | `CAPTURED` (chain contains a SUCCESS) / `FAILED` (all attempts failed) / `REFUNDED` (captured, later reversed) |
| `method` | `card` / `upi` / `netbanking` / `wallet` |
| `attempt_count` | equals the chain length, enforced |
| `created_at`, `updated_at`, `refunded_at` | `refunded_at` present iff `REFUNDED` |

### 4.4 `data/payment_attempts.csv` — 1,223 rows

The granular ledger the detector actually reasons over.

| Column | Notes |
|---|---|
| `attempt_id` PK | `pa_000001` … |
| `transaction_id`, `customer_id` | FK; customer must agree with the transaction |
| `amount_paise` | equals the transaction amount |
| `status` | `SUCCESS` / `FAILED` |
| `failure_reason` | required iff `FAILED`, empty iff `SUCCESS` |
| `attempt_no` | contiguous `1..n` per transaction |
| `retry_of_attempt_id` | empty on the first attempt, otherwise the previous attempt in the chain |
| `gateway_ref` | synthetic placeholder, later replaced by real Razorpay ids |
| `created_at` | chronological within the chain |

**Chain invariants, all validator-enforced:** at most one `SUCCESS`; a `SUCCESS` is always terminal; numbering is contiguous; `retry_of_attempt_id` forms an unbroken chain; timestamps ascend.

### 4.5 `data/merchant_config.json`

Configuration, not data. Holds what would otherwise leak into rows as labels.

- `dataset` — seed, `reference_date`, window bounds
- `detector_config` — **the recoverable/non-recoverable failure-reason classification**, recency window (30 days), `min_transaction_amount_paise` (₹500), `min_customer_lifetime_value_paise` (₹2,000)
- `customer_tiers` — LTV thresholds
- `guardrail_policy` — the ten MVP rules from `ARCHITECTURE.md` §6 with concrete limits
- `playbooks` — the three MVP playbooks with discount and channel cost
- `playbook_priors` — Beta(α, β) pseudo-counts per `(playbook, failure_reason)`, strength 40
- `estimator_config` — gateway fee bps, attribution window

Putting the failure-reason classification **here** rather than on each row is the distinction that matters: it is a merchant policy decision the detector reads and the merchant can edit, not a per-row answer key.

### 4.6 `data/dataset_summary.json`

Machine-readable summary: row counts, money totals in paise (plus display rupees), tier and failure-reason distributions, transaction status distribution, suppression counts, planted cohort sizes, and a `derived_opportunity_view` computed by applying `detector_config` to the raw rows. The validator recomputes that view independently and fails on any disagreement.

### 4.7 `data/scenario_manifest.json` — test fixture, not application data

Records which planted cohort each customer and transaction belongs to, so the validator can assert cohort-level outcomes without re-implementing the detector twice.

> **This file must never be read by the RevenuePilot application.** Loading it would hand the detector the labels it exists to derive. It carries a `_warning` field saying so.

---

## 5. Failure reason taxonomy

Internal synthetic classifications for the demo. **These are not Razorpay webhook enums** and no correspondence is claimed. Mapping real Razorpay error codes onto these categories is a Phase 6 task, recorded in `docs/RAZORPAY_NOTES.md` against current official documentation.

| Reason | Classified | Rationale |
|---|---|---|
| `insufficient_funds` | recoverable | Balance changes; a well-timed retry often lands |
| `payment_network_error` | recoverable | Transient; highest retry success |
| `authentication_failed` | recoverable | 3DS/OTP drop-off; usually completes on a second run |
| `payment_method_declined` | recoverable | Issuer decline; another method may work |
| `expired_card` | recoverable | Fixable by the customer updating details |
| `suspected_fraud` | **non-recoverable** | Must never be re-solicited |
| `unknown` | **non-recoverable** | Conservative default; unexplained failures are not chased |

Distribution across 89 failed attempts: `expired_card` 18, `payment_method_declined` 17, `payment_network_error` 16, `insufficient_funds` 14, `authentication_failed` 12, `unknown` 7, `suspected_fraud` 5.

---

## 6. Planted scenarios

Every cohort is a **discrimination test**. Together they guarantee the detector cannot pass by simply counting failed payments.

| Cohort | Size | Shape | Expected detector outcome |
|---|---|---|---|
| **A** `HIGH_VALUE_RECOVERABLE` | 12 | HIGH tier, ₹2,999–₹14,999 ticket, recoverable reason, no retry, contactable, 2–25 days old | **Detected** |
| **B1** `NON_RECOVERABLE_REASON` | 8 | Otherwise ideal, but `suspected_fraud` / `unknown` | Excluded — `NON_RECOVERABLE_REASON` |
| **B2** `SUPPRESSED_CUSTOMER` | 6 | Recoverable and valuable; **active** `do_not_contact_until` | Excluded — `SUPPRESSED` |
| **C** `ALREADY_RECOVERED` | 10 | FAILED attempt followed by a genuine SUCCESS | Excluded — `ALREADY_RECOVERED` |
| **D** `REPEATED_FAILURE` | 8 | 2–4 failed attempts on one transaction, still unpaid | **Detected once** (per transaction, not per attempt) |
| **E** `LOW_VALUE_FAILURE` | 12 | Half below the ₹500 ticket floor, half above it but with sub-₹2,000 LTV | Excluded — `BELOW_TICKET_FLOOR` / `BELOW_LTV_FLOOR` |
| **F** `HIGH_VALUE_OPPORTUNITY` | 6 | ₹24,999–₹89,999 ticket, strong recovery reason | **Detected** — dominates expected value |
| **G** `STALE_FAILURE` | 8 | Recoverable in kind, 65–170 days old | Excluded — `STALE` |
| **H** `EXPIRED_SUPPRESSION` | 9 | `do_not_contact_until` in the **past** | Must **not** be excluded on suppression grounds |
| **I** `ORGANIC_FAILURE` | 6 | Uncurated background noise, mixed reasons and ages | Mixed, by the rules |
| **J** `REFUNDED` | 15 | Captured then reversed | Excluded from captured revenue |

Cohort B2 deserves a note: its customers are deliberately given MEDIUM-tier LTV so that **suppression is the only binding constraint**. An earlier draft let them fall below the LTV floor, which meant the cohort silently tested the wrong exclusion — caught by the validator's "excluded for the right reason" assertion, which checks not just *that* a row was excluded but *why*.

---

## 7. Generated dataset — actuals

Seed `20260905`, reference date `2026-09-01`.

| Metric | Value |
|---|---|
| Customers / Products / Transactions / Attempts | 500 / 18 / 1,200 / 1,223 |
| Failed attempts | **89** (target band 60–100) |
| Transactions: CAPTURED / FAILED / REFUNDED | 1,119 / 66 / 15 |
| Multi-attempt transactions | 18 |
| Customers with ≥1 failed payment | 76 |
| Tier distribution HIGH / MEDIUM / LOW | 65 / 141 / 294 |
| Actively suppressed / expired suppression | 6 / 9 |
| Total transaction value | ₹1,22,57,806 |
| Captured revenue | ₹1,12,08,591 |
| Refunded value | ₹1,75,381 |
| Failed payment value | ₹8,73,834 |
| **Qualifying opportunities** | **26 transactions, 26 customers, ₹5,14,274** |
| Qualifying by tier | HIGH 19, MEDIUM 7 |

**Discrimination ratio:** 66 failed transactions exist; only 26 qualify. The detector must reject 40 of them, for five distinct reasons. The exclusion breakdown is `ALREADY_RECOVERED` 1134 (i.e. every captured transaction), `NON_RECOVERABLE_REASON` 12, `STALE` 10, `BELOW_LTV_FLOOR` 6, `BELOW_TICKET_FLOOR` 6, `SUPPRESSED` 6.

> `ARCHITECTURE.md` §16 quotes an illustrative "23 recoverable failed payments — ₹1,84,000". The real figures are **26 / ₹5,14,274**. The demo script should be updated to the generated numbers when we write `DEMO_SCRIPT.md`.

---

## 8. Validation

`analytics/validate_dataset.py` reads **only the emitted files** — it does not import the generator. If the two ever disagree, that is the finding.

**107 checks**, covering: unique and non-empty IDs · all six foreign-key relationships · positive-integer amounts · `amount = price × quantity` · attempt-to-transaction amount agreement · currency uniformity · parseable timestamps · nothing after `reference_date` · transactions after signup · refunds after settlement · `FAILED` implies a reason · `SUCCESS` implies none · known reason categories · every declared category present · suppression date/reason mutual implication · active and expired suppression both present · contiguous `attempt_no` · unbroken retry chain · chronological chains · one terminal `SUCCESS` · `attempt_count` agreement · `status` agreement with chain · `refunded_at` iff `REFUNDED` · LTV ≥ in-window captured · `historical + in-window = lifetime` · tier matches thresholds · all three tiers populated · demo viability floors · **all five exclusion categories populated** · every cohort resolving to its intended outcome **and for the intended reason** · summary agreement with independent re-derivation · scale targets · no label leakage.

```bash
python3 analytics/generate_dataset.py && python3 analytics/validate_dataset.py
```

**Demo-viability floors** (build fails below these, rather than discovering it on stage): ≥15 qualifying opportunities, ≥₹1,00,000 recoverable, ≥5 HIGH-tier, ≥3 repeated-failure, ≥3 distinct failure reasons among qualifiers, ≥3 cases in every exclusion category.

### Determinism, verified

Same seed under `PYTHONHASHSEED` 1, 999, and `random` → byte-identical output (`5494d02f…`). A different `--seed` produces a different dataset that **still passes all 107 checks** — the generator is robust, not tuned to one lucky draw.

---

## 9. Mapping into the RevenuePilot domain model

Phase 1 loads these files; Phase 2 consumes them. No schema is being built yet — this records the intended correspondence.

| File | Prisma model (`ARCHITECTURE.md` §3) | Notes |
|---|---|---|
| `customers.csv` | `Customer` | Direct. `do_not_contact_until` → `doNotContactUntil`, read by the `DO_NOT_CONTACT` guardrail |
| `products.csv` | *(new)* `Product` | Not in the original §3 list; needed for realistic tickets and category-level analysis |
| `transactions.csv` | `Transaction` | `status` maps to `CAPTURED / FAILED / REFUNDED`; `raw` Json holds the source row |
| `payment_attempts.csv` | *(new)* `PaymentAttempt` | §3 modelled attempts inside `Transaction.raw`. Promoting them to a first-class table is a **proposed schema amendment** — retry chains are the detector's core evidence and belong in a queryable table |
| `merchant_config.json` → `detector_config` | detector configuration | Loaded as config, never as rows |
| `merchant_config.json` → `guardrail_policy` | `GuardrailPolicy` v1 | Seeds the initial policy |
| `merchant_config.json` → `playbooks` | `Playbook` | The three MVP playbooks |
| `merchant_config.json` → `playbook_priors` | `PlaybookStat` | Seeds `alpha`/`beta` so cold start is not 0/0 |
| `dataset_summary.json` | — | Build-time reference and regression baseline |
| `scenario_manifest.json` | — | **Test fixture only.** Never loaded by the application |

**Two schema amendments this work surfaces**, for approval before Phase 0: add a `Product` model, and promote `PaymentAttempt` to a first-class model rather than burying attempts in `Transaction.raw`.

---

## 10. What the detector derives

`FailedPaymentRecoveryDetector` reads `Transaction` + `PaymentAttempt` + `Customer`, applies `detector_config`, and emits one `Opportunity` with `OpportunityTarget` rows. Per transaction, in order:

1. **Group** attempts by `transaction_id`, order by `attempt_no`.
2. **Already recovered?** Any `SUCCESS` in the chain → exclude. *(Cohort C.)*
3. **Latest failure** = last `FAILED` attempt. Its reason is the operative one — a chain that ends in `expired_card` is an expired-card problem regardless of how it began. *(Cohort D.)*
4. **Reason recoverable?** Membership in `recoverable_failure_reasons` → else exclude. *(Cohort B1.)*
5. **Recent enough?** `latest.created_at ≥ reference_date − 30d` → else exclude. *(Cohort G.)*
6. **Ticket above floor?** `amount_paise ≥ ₹500` → else exclude. *(Cohort E, first half.)*
7. **Customer above LTV floor?** `lifetime_value_paise ≥ ₹2,000` → else exclude. *(Cohort E, second half.)*
8. **Contactable?** `do_not_contact_until` empty **or in the past** → else exclude. *(Cohort B2 excluded; cohort H not excluded.)*

It then aggregates the survivors into one `Opportunity` carrying **observed facts only**: `affectedCustomerCount` = 26, `recoverableAmountPaise` = 51,427,400, and a `failureReasonBreakdown`. Not a probability, not a projection.

The estimator takes over from there (`ARCHITECTURE.md` §2): `p_recover` comes from `PlaybookStat` priors seeded by §4.5, modified by recency, tier, and discount depth — all deterministic, all in TypeScript, all before any LLM is called.

**Evidence the dataset supplies for each downstream stage:**

| Stage | Supplied by |
|---|---|
| OBSERVE | attempt chains, failure reasons, timestamps, suppression state, LTV, tier |
| REASON | ticket amounts, failure-reason mix, tier mix, seeded Beta priors |
| PLAN | candidate targets with per-customer context for message drafting |
| GUARDRAIL | `do_not_contact_until`, LTV, ticket size, policy limits in `guardrail_policy` |
| ACT | customer refs and amounts for payment-link creation in Test Mode |
| VERIFY | `gateway_ref` placeholders, replaced by real Razorpay ids at execution |
| LEARN | `playbook_priors` as the starting belief that real outcomes then move |

---

## 11. Regeneration policy

- `data/` is **committed**. The demo must not depend on anyone regenerating anything.
- Regenerating changes every id. Do it deliberately, re-run the validator, and update §7 in the same commit.
- Changing a cohort size or a threshold requires re-running both scripts and updating §6/§7.
- `--end-date` shifts the whole window. The default stays fixed so output is reproducible across days; the detector reads `reference_date` from config rather than the clock, so a stale default never breaks recency logic.

## 12. Known limitations

- **Recovery outcomes are not simulated.** The dataset ends at the failure. Whether a recovery attempt succeeds is decided at demo time via Razorpay Test Mode or the simulation endpoint — deliberately, since inventing outcomes here would be exactly the "made-up financial results" this dataset must not contain.
- **`p_recover` priors are hand-set**, not learned from these records — they are plausible starting beliefs. Real outcomes overwrite them through the LEARN step.
- **One detector's worth of data.** Subscription churn and abandoned checkouts (`ARCHITECTURE.md` §12) would need new columns.
- **Failure reasons are ours, not Razorpay's.** Mapping to real error codes happens in Phase 6.
- **No partial refunds, disputes, settlement timing, or multi-currency.** Out of MVP scope.
