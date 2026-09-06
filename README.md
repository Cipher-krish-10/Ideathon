# RevenuePilot

**An AI merchant growth agent for Razorpay.** It finds revenue a merchant has already lost, works out what it would cost to get back, proposes an action, checks that action against the merchant's own rules — and then stops, because a human decides whether money moves.

Built for the Razorpay hackathon track **AI Growth & Agentic Commerce**. Razorpay **Test Mode only**; there is no live-mode code path.

```
OBSERVE → REASON → PLAN → GUARDRAIL → HUMAN APPROVAL → ACT → VERIFY → LEARN
  ✅        ✅       ✅        ✅            ✅          ⬜      ⬜      ⬜
```

---

## The one idea

> **The LLM never produces a number that reaches the ledger.**

Everything financial is computed deterministically in TypeScript *before* a model is consulted. The model's job is to rank pre-scored options and explain the trade-off. That promise is structural, not a line in a prompt:

- The model's output schema has **no numeric field at all** — there is nowhere for an invented figure to live.
- Its chosen playbook is validated against the candidate set it was given.
- Every number appearing in its prose is matched against estimator output; a fabricated one is **rejected**, repaired once, then falls back to a deterministic choice that is labelled as such.
- A **deterministic guardrail engine** is authoritative over the recommendation, and it runs **twice** — once to show the merchant, once against fresh state immediately before acting.

---

## What it currently finds

From a controlled synthetic merchant (1,200 transactions, 1,223 payment attempts):

| | |
|---|---|
| Failed transactions | **66** |
| **Qualifying for recovery** | **26** |
| **Recoverable value** | **₹5,14,274.00** |
| Rejected, across 5 exclusion reasons | 40 |

The gap matters more than the total: the detector rejects `ALREADY_RECOVERED` (1134), `NON_RECOVERABLE_FAILURE` (12), `OUTSIDE_RECENCY_WINDOW` (10), `BELOW_TICKET_FLOOR` (6), `BELOW_LTV_FLOOR` (6), `SUPPRESSED` (6). It discriminates; it does not count failures.

Three strategies are then scored deterministically:

| Playbook | Recovery rate | Expected net | Confidence |
|---|---|---|---|
| Plain retry reminder | 28.36% | ₹1,42,921.20 | MEDIUM |
| Payment link, no incentive | 39.79% | ₹2,00,508.37 | MEDIUM |
| Payment link + 10% offer | 49.26% | ₹2,23,414.04 | MEDIUM |

Confidence is MEDIUM everywhere because the priors are seeded calibration with **zero recorded outcomes**. The system will not claim more than it has earned.

---

## Quick start

Requires **Node 22+** and **PostgreSQL 16+**.

```bash
npm install
createdb revenuepilot
cp .env.example .env          # set DATABASE_URL
npm run db:deploy             # apply migrations
npm run db:seed               # load the approved dataset
npm run demo:setup -- --scripted
npm run dev                   # http://localhost:3000
```

**Optional — real LLM reasoning.** Add either key to `.env`; without one the reasoner falls back deterministically and says so.

```bash
GROQ_API_KEY="gsk_..."         # or ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Demo

Full script with talking points: **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)** (~4 minutes).

The short version — Command Centre → **Run Agent** → open the **Decision Packet** → review the recommendation, the alternatives it rejected, and a ten-rule guardrail table showing *observed vs limit* → edit the customer message → **Approve**.

**The beat worth staying for.** Approve a proposal that passed its checks, but first lower the daily discount budget in Policies. The pre-execution guardrails re-read the world and **block it**:

> **Action blocked** — `DAILY_DISCOUNT_BUDGET_PAISE`: committed ₹0.00 plus this action's ₹25,331.91 would reach ₹25,331.91, over the ₹20,000.00 daily budget. *Nothing was sent and no money moved.*

The state a merchant reviews is not always the state that exists when they click. That gap is exactly how an agent does something nobody meant.

---

## Architecture

```
src/
  core/           pure domain — no Prisma, no network, no LLM, no side effects
    detectors/      failed-payment recovery: evidence → opportunities
    estimator/      deterministic scoring; fixed-point money and probability
    reasoner/       prompt building, output validation, repair/fallback
    guardrails/     ten rules + the aggregation engine
    state-machine/  legal intervention transitions
  server/         persistence, services, audit, auth  (the imperative shell)
  integrations/   llm/ — Anthropic + Groq behind one interface
  app/            Next.js App Router: 7 pages, 12 API routes
```

An **ESLint boundary rule** enforces the purity of `src/core` — importing Prisma, Next, the network, or an SDK from there fails the build. A second rule keeps the Prisma client inside `src/server`, so every query goes through a merchant-scoped repository.

**Money is an integer number of paise, everywhere.** There is not one floating-point column in the schema — verified structurally by a query against `information_schema`, so a future migration cannot quietly introduce one. Probabilities are basis points; Beta priors are milli-units.

**The audit log is append-only and hash-chained.** Each entry commits to its predecessor. Postgres rejects `UPDATE` outright and rejects `DELETE` without an explicit session flag. `verifyAuditChain` recomputes it end to end.

**Two database triggers enforce the central safety promise**: an intervention cannot enter any execution state, and an execution attempt cannot exist, without a recorded `APPROVED` approval. No code path — agent, API, script, or manual SQL — can bypass it.

---

## Verification

```bash
npm run verify     # typecheck · lint · 300 tests · 105 database checks
npm run test:e2e   # 9 Playwright tests, including the guardrail failure beat
```

| Layer | Coverage |
|---|---|
| Dataset | 107 checks; deterministic generation verified across hash seeds |
| Database | 105 checks against `dataset_summary.json`; no float columns; provenance on every derived row |
| Detector | Independently reproduces the Python validator: 26 / ₹5,14,274 |
| Estimator | Boundary tests per modifier; integer-paise arithmetic; scores but never chooses |
| Reasoner | 10 offline fixtures — hallucinated money, hallucinated percentage, unknown playbook, malformed JSON, prompt injection. **No test calls a live model.** |
| Guardrails | Every rule at the limit, one under, one over; severity aggregation |
| E2E | Approve, reject, edit, policy versioning, audit integrity, guardrail block |

---

## Handy commands

| Command | What it does |
|---|---|
| `npm run detector` | Run the detector and print what it rejected, and why |
| `npm run estimator` | Score all playbooks with a worked example |
| `npm run reasoner` | Full reasoning run (add `--scripted` for offline) |
| `npm run reasoner -- --inject` | Prompt-injection attempt, fenced as untrusted data |
| `npm run demo:setup -- --block` | Land directly in the guardrail-blocked state |
| `npm run db:validate` | Check the database against the approved dataset |

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, agent architecture, failure modes, security |
| [docs/DATASET_SPEC.md](docs/DATASET_SPEC.md) | The synthetic merchant, its planted scenarios, and why each exists |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Every model, its invariants, and how dataset fields map into it |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The four-minute demo, with talking points |

---

## Not built yet

Razorpay execution · webhook ingestion · attribution · the LEARN step · production authentication.

The seams are already in place for them: a `PaymentProvider` interface with a fake implementation, an `ExecutionAttempt` table with persisted idempotency keys, `WebhookEvent` and `AttributionRecord` models, and `PlaybookStat` counters that preserve their seeded values so learned movement stays visible.

## Stack

Next.js 16 · TypeScript (strict) · PostgreSQL 16 · Prisma 7 · Zod · Vitest · Playwright · Anthropic / Groq
