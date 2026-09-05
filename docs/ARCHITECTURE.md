# RevenuePilot — Architecture Proposal

**Status:** Proposal, awaiting approval. No implementation code written yet.
**Track:** Razorpay Hackathon — AI Growth & Agentic Commerce
**Mode:** Razorpay **Test Mode only**, enforced in code.

---

## 0. Governing principles

These five constraints drive every decision below.

1. **The LLM never executes a financial action.** It emits a structured *proposal*. Execution is a separate, deterministic, human-gated path.
2. **The LLM never produces a number that reaches the ledger.** Detectors and the estimator are deterministic TypeScript. The LLM ranks pre-scored candidates, drafts copy, and writes prose explanations that *cite* computed values. Any figure in the UI traces to a row in the database, not to a token stream.
3. **The deterministic core must work with the LLM removed.** A rule-based ranker is the fallback path, not an afterthought. If the model API is down mid-demo, the product still runs and says so.
4. **Guardrails are evaluated twice** — at proposal time (so the merchant sees them) and again immediately before execution (because state drifts between approval and action).
5. **Every state transition is appended to a hash-chained audit log.** Nothing mutates a decision record.

---

## 1. System architecture

Single Next.js application (App Router) with a strictly layered interior. The layering matters more than the process count: everything under `src/core/` is framework-free, dependency-injected, and unit-testable without a server or a network.

```
┌────────────────────────────────────────────────────────────┐
│  UI LAYER — Next.js RSC + client components                │
│  Opportunity inbox · Proposal review · Policy editor        │
│  Audit explorer · Revenue dashboard                         │
└───────────────────────────┬────────────────────────────────┘
                            │ typed server actions / route handlers
┌───────────────────────────▼────────────────────────────────┐
│  APPLICATION LAYER — route handlers, auth, tenant scoping   │
│  Validates input (Zod) · resolves session · no domain logic │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│  AGENT ORCHESTRATOR — the state machine driver              │
│  Owns the OBSERVE→…→LEARN loop. Calls the modules below in  │
│  fixed order. Holds no business rules of its own.           │
└──┬──────┬──────┬──────┬───────┬──────────┬─────────┬───────┘
   │      │      │      │       │          │         │
   ▼      ▼      ▼      ▼       ▼          ▼         ▼
┌──────┐┌──────┐┌─────┐┌──────┐┌────────┐┌────────┐┌────────┐
│DETECT││ESTIM ││ LLM ││GUARD ││EXECUTOR││ATTRIBU ││ AUDIT  │
│ ORS  ││ ATOR ││REASO││ RAIL ││        ││  TION  ││ LOGGER │
│      ││      ││ NER ││ENGINE││        ││ ENGINE ││        │
│determ││determ││ non-││determ││ side-  ││ determ ││ append │
│inisti││inisti││ auth││inisti││ effect ││ inistic││ only   │
│  c   ││  c   ││orita││  c   ││ ful    ││        ││        │
│      ││      ││tive ││      ││        ││        ││        │
└──────┘└──────┘└─────┘└──────┘└───┬────┘└───▲────┘└────────┘
                                   │         │
                      ┌────────────▼─┐   ┌───┴──────────┐
                      │ RAZORPAY     │   │ WEBHOOK      │
                      │ ADAPTER      │   │ INGEST       │
                      │ (only holder │   │ (signature   │
                      │  of secrets) │   │  verified)   │
                      └──────┬───────┘   └───▲──────────┘
                             │               │
                        ╔════▼═══════════════┴═══╗
                        ║  RAZORPAY TEST MODE     ║
                        ╚════════════════════════╝

           ┌──────────────────────────────────────┐
           │ PostgreSQL (Prisma) — single source  │
           │ of truth for every number shown      │
           └──────────────────────────────────────┘
```

**Module boundaries and why they exist:**

| Module | Purity | Responsibility | Explicitly NOT allowed to |
|---|---|---|---|
| Detectors | Pure | Scan transactions → `Opportunity` rows with hard counts and amounts | Call the LLM; estimate value |
| Estimator | Pure | Score `(opportunity × playbook)` → expected gross, cost, net, confidence | Choose the winner |
| LLM Reasoner | Impure, non-authoritative | Rank scored candidates, draft copy, write explanation | Emit numbers, call any tool, touch Razorpay |
| Guardrail Engine | Pure | `evaluate(action, policy, state) → decision + reasons` | Have side effects; be skipped |
| Executor | Side-effectful | Call Razorpay with idempotency key, record attempt | Run without a valid `Approval` row |
| Attribution Engine | Pure | Map payment events → interventions with a confidence tier | Guess silently — unattributed is a valid output |
| Audit Logger | Append-only | Hash-chained record of every transition | Update or delete |

**Where Python goes.** Not in the request path. Python earns its place *offline*, for two jobs: (a) generating the synthetic merchant dataset with realistic failure-reason distributions and customer LTV curves, (b) calibrating the base-rate priors that seed `PlaybookStat`. Both produce JSON/CSV committed as seed data. Introducing a live Python service for MVP would add a deployment surface, a network hop, and a failure mode in exchange for nothing the TypeScript estimator cannot do. Revisit post-MVP if uplift modelling becomes real.

---

## 2. Agent architecture

The orchestrator is a **deterministic driver over a state machine**, not an autonomous loop. It has no freedom to choose its own next step — the state machine does. This is the single most important design decision for the "bounded actions" requirement.

### Cycle: OBSERVE → REASON → PLAN → GUARDRAIL → APPROVAL → ACT → VERIFY → LEARN

**OBSERVE** — Detectors run over `Transaction` + `Customer`. MVP ships one detector, `FailedPaymentRecoveryDetector`, which groups failed payments by customer and filters on: failure was recoverable (not fraud/stolen-card), no successful retry since, within a recency window, customer value above floor. Output: `Opportunity` rows carrying only observed facts — `affectedCustomerCount`, `recoverableAmountPaise`, `failureReasonBreakdown`. No projections.

**REASON** — For each opportunity, the estimator scores every eligible `Playbook`:

```
p_recover(customer, playbook)
    = base_rate(playbook, failureReason)        -- from PlaybookStat priors
    × recency_modifier(daysSinceFailure)
    × value_tier_modifier(customerTier)
    × incentive_modifier(discountBps)

expectedGrossPaise = Σ_customers  recoverableAmountPaise × p_recover
costPaise          = discountCost + channelCost + estimatedGatewayFee
expectedNetPaise   = expectedGrossPaise − costPaise
confidence         = f(priorSampleSize, dataCompleteness)  →  LOW | MEDIUM | HIGH
```

Every candidate is persisted as an `Estimate` row *before* the LLM sees anything. The LLM receives a compact, pre-scored table.

**PLAN** — The LLM Reasoner is called with the opportunity summary and the scored candidate table. Its output is validated against a strict Zod schema:

```ts
{
  selectedPlaybookId: string,        // must exist in the candidate set
  rationale: string,                 // prose, must reference candidates
  customerMessage: { subject, body },// drafted copy, merchant-editable
  risksIdentified: string[],
  confidenceNote: string
}
```

Rejected on: unknown `selectedPlaybookId`, schema violation, or any numeric claim in `rationale` that does not match a value in the injected candidate table (checked by regex-extract-and-compare — a cheap, effective hallucination guard). On rejection: one repair attempt with the validation error, then fall back to `argmax(expectedNetPaise)` with a system-authored rationale, and flag the intervention `reasoningMode: DETERMINISTIC_FALLBACK` in the UI. **The agent never stalls because the model misbehaved.**

**GUARDRAIL / APPROVAL / ACT / VERIFY / LEARN** — sections 6, 5, 8, 9, and below.

**LEARN** — `PlaybookStat` holds Beta-distribution counters per `(playbookId, failureReason, customerTier)`: `alpha` (conversions), `beta` (non-conversions). On attribution close-out, increment the appropriate counter. `base_rate = alpha / (alpha + beta)`. Priors seeded from the Python calibration pass so cold start is not 0/0. This is genuinely simple, genuinely Bayesian, and visibly moves the numbers during a demo if you run two cycles.

---

## 3. Database entities

Postgres via Prisma. Every tenant-scoped table carries `merchantId` and is queried through a repository layer that injects it — no route handler writes a raw unscoped query.

**Identity & tenancy**
- `Merchant` — id, name, razorpayKeyIdRef, mode (`TEST`), timezone, createdAt
- `User` — id, merchantId, email, role (`VIEWER | APPROVER | ADMIN`)
- `Session` — auth session storage

**Source data**
- `Customer` — id, merchantId, externalRef, maskedEmail, maskedPhone, lifetimeValuePaise, tier, doNotContactUntil, createdAt
- `Transaction` — id, merchantId, customerId, razorpayPaymentId?, amountPaise, currency, status (`CAPTURED | FAILED | REFUNDED | PENDING`), failureReason?, method, attemptedAt, raw Json

**Agent reasoning**
- `Opportunity` — id, merchantId, type (`FAILED_PAYMENT_RECOVERY`), detectorVersion, status, affectedCustomerCount, recoverableAmountPaise, evidence Json, detectedAt
- `OpportunityTarget` — opportunityId, customerId, transactionId, recoverableAmountPaise
- `Playbook` — id, key, name, description, actionType (`PAYMENT_LINK_WITH_OFFER | PAYMENT_LINK_PLAIN | REMINDER_ONLY`), defaultDiscountBps, channel, isActive
- `Estimate` — id, opportunityId, playbookId, expectedGrossPaise, costPaise, expectedNetPaise, pRecoverAvg, confidence, inputsSnapshot Json, estimatorVersion
- `LlmCall` — id, interventionId?, model, promptHash, promptText, rawResponse, parsedOutput Json, validationResult, latencyMs, inputTokens, outputTokens, costPaise, createdAt

**Decision & action**
- `Intervention` — id, merchantId, opportunityId, playbookId, estimateId, state (see §5), reasoningMode, rationale, customerMessage Json, version (optimistic lock), attributionRef (unique), expiresAt, timestamps
- `InterventionTarget` — interventionId, customerId, transactionId, amountPaise, perTargetRef, status
- `GuardrailPolicy` — id, merchantId, version, rules Json, isActive, updatedBy, updatedAt
- `GuardrailEvaluation` — id, interventionId, policyVersion, phase (`PRE_APPROVAL | PRE_EXECUTION`), decision (`PASS | WARN | REQUIRE_APPROVAL | BLOCK`), ruleResults Json, evaluatedAt
- `Approval` — id, interventionId, userId, decision (`APPROVED | REJECTED`), note, editedMessage Json?, decidedAt
- `ExecutionAttempt` — id, interventionId, targetId?, attemptNo, idempotencyKey (unique), request Json, responseStatus, response Json, error?, startedAt, finishedAt
- `RazorpayArtifact` — id, interventionId, artifactType, razorpayEntityId, shortUrl?, amountPaise, status, raw Json

**Outcome**
- `WebhookEvent` — id, razorpayEventId (unique), eventType, signatureValid, rawBody, headers Json, receivedAt, processedAt?, processingError?
- `AttributionRecord` — id, interventionId, transactionId, webhookEventId, method (`DIRECT_REF | WINDOW_MATCH | MANUAL`), confidence, attributedAmountPaise, attributedAt
- `PlaybookStat` — id, merchantId, playbookId, failureReason, customerTier, alpha, beta, lastUpdatedAt
- `AuditLog` — id, merchantId, seq (monotonic per merchant), actorType (`SYSTEM | AGENT | USER | WEBHOOK`), actorId?, entityType, entityId, action, before Json?, after Json?, prevHash, hash, createdAt

---

## 4. API routes

All under `/api`. Mutating routes require session + CSRF + role check. Every handler: parse with Zod → resolve tenant → delegate to `core/` → map to response. No domain logic in handlers.

**Data & opportunities**
- `POST /api/seed` — load synthetic merchant dataset (dev/demo only, env-gated)
- `GET  /api/opportunities` — list, filterable by status
- `GET  /api/opportunities/:id` — detail with targets and all `Estimate` rows

**Agent**
- `POST /api/agent/run` — run OBSERVE→REASON→PLAN→GUARDRAIL for a merchant; returns created interventions. Idempotent per `(merchantId, detectorVersion, day)` to prevent duplicate proposals.
- `GET  /api/interventions` — list by state
- `GET  /api/interventions/:id` — full decision packet: estimate, alternatives considered, guardrail results, LLM call record, audit trail

**Human gate**
- `POST /api/interventions/:id/approve` — body `{ version, editedMessage? }`. Rejects on version mismatch (concurrent approval). Role `APPROVER`+.
- `POST /api/interventions/:id/reject` — body `{ version, reason }`
- `POST /api/interventions/:id/cancel` — pre-execution abort

**Execution**
- `POST /api/interventions/:id/execute` — internal; invoked by the approval path and by the retry worker. Re-runs guardrails (`PRE_EXECUTION`) before any Razorpay call. Never callable without a matching `Approval`.

**Events**
- `POST /api/webhooks/razorpay` — raw-body signature verification, dedupe by event id, enqueue for processing. Always returns 2xx once persisted.

**Policy, audit, metrics**
- `GET|PUT /api/policies` — guardrail policy (PUT creates a new version, never mutates)
- `GET /api/audit` — paginated, filterable; includes chain-verification status
- `GET /api/metrics/dashboard` — proposed vs approved vs executed vs recovered, per playbook

**Demo support**
- `POST /api/simulate/payment` — env-gated; simulates a customer completing a payment link so the demo does not depend on live checkout timing. Clearly labelled in the UI as simulated.

---

## 5. Agent state machine

`Intervention.state` is the single source of truth. Transitions are the only way to change it, each one wrapped in a transaction that also writes an `AuditLog` row.

```
                    ┌─────────┐
                    │  DRAFT  │  (estimator done, LLM pending)
                    └────┬────┘
                         │ reasoner returns valid proposal
                    ┌────▼─────┐
                    │ PROPOSED │
                    └────┬─────┘
                         │ guardrails PRE_APPROVAL
          ┌──────────────┼──────────────────┐
          │ BLOCK        │ PASS/WARN/REQ    │
   ┌──────▼──────────┐   │                  │
   │GUARDRAIL_BLOCKED│   │                  │
   └─────────────────┘   │                  │
        (terminal)  ┌────▼─────────────┐    │
                    │ PENDING_APPROVAL │◄───┘
                    └──┬────┬──────┬───┘
         reject ───────┘    │      └─────── expiresAt passed
       ┌──────────┐         │ approve        ┌─────────┐
       │ REJECTED │    ┌────▼─────┐          │ EXPIRED │
       └──────────┘    │ APPROVED │          └─────────┘
        (terminal)     └────┬─────┘           (terminal)
                            │ execute()
                            │ guardrails PRE_EXECUTION
              ┌─────────────┼──────────────┐
              │ BLOCK       │ PASS         │
       ┌──────▼──────────┐  │              │
       │GUARDRAIL_BLOCKED│  │        ┌─────▼─────┐
       └─────────────────┘  │        │ EXECUTING │
                            │        └──┬─────┬──┘
                            │  success  │     │ error
                            │      ┌────▼──┐  │
                            │      │EXECUTED│ │
                            │      └────┬───┘ │
                            │           │  ┌──▼───────────────┐
                            │           │  │ EXECUTION_FAILED │
                            │           │  └──┬───────────────┘
                            │           │     │ retry (bounded)
                            │           │     └──► EXECUTING
                            │      ┌────▼──────┐
                            │      │ OBSERVING │ (awaiting webhooks)
                            │      └──┬─────┬──┘
                            │ payment │     │ window elapsed
                            │      ┌──▼──────┐  ┌───────────┐
                            │      │CONVERTED│  │ NOT_      │
                            │      └────┬────┘  │ CONVERTED │
                            │           │       └─────┬─────┘
                            │           └──────┬──────┘
                            │              ┌───▼────┐
                            └─────────────►│ LEARNED│ (stats updated)
                                           └────────┘
```

**Terminal states:** `GUARDRAIL_BLOCKED`, `REJECTED`, `EXPIRED`, `LEARNED`, `CANCELLED`.

**Invariants enforced in code, not convention:**
- `EXECUTING` is unreachable without a matching `Approval` row and a `PRE_EXECUTION` evaluation of `PASS`.
- `EXECUTED` requires at least one `ExecutionAttempt` with a persisted idempotency key.
- No transition writes without a paired `AuditLog` insert in the same transaction.
- Transitions are guarded by `version` (optimistic lock) so two approvers cannot both advance it.

---

## 6. Guardrail design

A guardrail is a pure function over `(proposedAction, policy, currentState)` returning a typed result. Rules are declarative and stored as a versioned JSON policy so the merchant can edit them in the UI without a deploy.

```ts
type RuleResult = {
  ruleId: string
  severity: 'BLOCK' | 'REQUIRE_APPROVAL' | 'WARN'
  passed: boolean
  observed: number | string        // what we measured
  limit:    number | string        // what the policy allows
  message:  string                 // merchant-readable
}
```

Engine decision = most severe failing result. `BLOCK` is absolute — no human override path in MVP (an override is a post-MVP feature with its own audit event).

**MVP rule set:**

| Rule | Severity | Rationale |
|---|---|---|
| `MAX_DISCOUNT_BPS` — per-intervention discount ceiling | BLOCK | Caps margin damage |
| `MAX_SINGLE_ACTION_EXPOSURE` — total discount value of one intervention | BLOCK | Caps blast radius |
| `DAILY_DISCOUNT_BUDGET` — rolling 24h spend across all interventions | BLOCK | Prevents drip-drain |
| `MIN_EXPECTED_NET` — reject value-destroying actions | BLOCK | Agent must not act at a loss |
| `MAX_CONTACTS_PER_CUSTOMER` — n per rolling window | BLOCK | Contact fatigue / spam |
| `DO_NOT_CONTACT` — respects `doNotContactUntil` and suppression list | BLOCK | Consent |
| `QUIET_HOURS` — merchant-timezone send window | REQUIRE_APPROVAL | Scheduling, not prohibition |
| `MAX_CONCURRENT_LIVE` — cap on simultaneous open interventions | BLOCK | Bounded autonomy |
| `TEST_MODE_ONLY` — hard assertion that the adapter is in test mode | BLOCK | Non-negotiable kill switch |
| `LOW_CONFIDENCE` — confidence below threshold | REQUIRE_APPROVAL | Surfaces uncertainty |

**Two-phase evaluation.** `PRE_APPROVAL` results are rendered in the review UI so the merchant sees exactly what was checked. `PRE_EXECUTION` re-runs the identical function against fresh state immediately before the Razorpay call — because budget may have been consumed, the customer may have opted out, or another intervention may have contacted them since approval. A `BLOCK` at this stage moves the intervention to `GUARDRAIL_BLOCKED` and the merchant is told which rule changed and why. This closes the time-of-check/time-of-use gap that most agent demos ignore.

---

## 7. Audit-log design

Append-only, tamper-evident, and queryable as a narrative.

- **Hash chain per merchant.** `hash = sha256(seq ‖ prevHash ‖ canonicalJson(payload))`. A `GET /api/audit` response includes a chain-verification result, so the UI can display "integrity verified — 47 events". Cheap to build, and it makes the audit-trail claim demonstrable rather than asserted.
- **No updates, no deletes.** The Prisma access layer for `AuditLog` exposes only `append` and `read`. Enforced additionally by a Postgres rule/trigger and by revoking `UPDATE`/`DELETE` on the table from the application role.
- **Every actor is typed.** `SYSTEM` (scheduled detector run), `AGENT` (LLM-influenced proposal), `USER` (approval, policy edit), `WEBHOOK` (external event). The demo story "who decided this?" is answerable in one query.
- **Captured events:** detector run, opportunity created, estimates computed, LLM call issued and validated (with prompt hash and token cost), proposal created, each guardrail evaluation with full rule results, approval/rejection with the approver's identity and any message edits, each execution attempt with request/response, each webhook received, each attribution decision, each `PlaybookStat` update, and every policy version change.
- **Redaction.** PII is masked at write time. The audit log stores references and masked values, never raw card data or full contact details.

---

## 8. Razorpay integration boundaries

An **anti-corruption layer**. Nothing outside `src/integrations/razorpay/` knows Razorpay's vocabulary.

```ts
interface PaymentProvider {
  createPaymentLink(cmd: CreatePaymentLinkCommand, idempotencyKey: string)
      : Promise<Result<PaymentLinkArtifact, ProviderError>>
  fetchPaymentLink(id: string): Promise<Result<PaymentLinkArtifact, ProviderError>>
  cancelPaymentLink(id: string): Promise<Result<void, ProviderError>>
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean
}
```

- **Only holder of credentials.** Keys live in server-only env vars, read in this module alone. They are never imported into anything that could be bundled client-side.
- **Exact request/response shapes are deliberately unspecified in this document.** The command and artifact types will be finalised against the **current official Razorpay documentation** at implementation time. Every field mapping gets a `// verified against docs YYYY-MM-DD` marker. Assumptions here would be a liability.
- **Two implementations from day one:** `RazorpayProvider` (real, test mode) and `FakeProvider` (in-memory, deterministic). All tests and the offline demo path run against the fake. This means we can build and demo the entire loop before the integration is finished, and it gives us a fallback if the network is hostile on demo day.
- **Idempotency.** Every mutating call carries a key derived as `sha256(interventionId ‖ targetId ‖ attemptNo)`, persisted on `ExecutionAttempt` *before* the call is issued. A crash between issue and response cannot produce a double action — the retry reuses the key. (Whether Razorpay honours a native idempotency header will be confirmed from the docs; if it does not, the persisted-key-plus-artifact-lookup pattern gives us the same guarantee application-side.)
- **Test-mode assertion.** The adapter refuses to construct if the configured key is not a test-mode key, and the `TEST_MODE_ONLY` guardrail asserts it again per action.
- **Timeouts and retries.** Hard timeout, bounded exponential backoff, retry only on network errors and 5xx — never on 4xx. Circuit breaker after repeated failures, which degrades the system to "proposals only" rather than taking it down.

---

## 9. Webhook architecture

Two strictly separated stages. Conflating them is the classic source of lost events.

**Stage 1 — Receive (must be fast and near-infallible)**
1. Read the **raw** body before any JSON parsing (signature is computed over exact bytes).
2. Verify HMAC signature. Invalid → persist with `signatureValid: false`, return 400, raise an alert. Never process.
3. Dedupe on Razorpay's event id (`WebhookEvent.razorpayEventId` unique). Duplicate → return 200 immediately, no reprocessing.
4. Persist the raw event verbatim. Return 2xx.

**Stage 2 — Process (asynchronous, idempotent, retryable)**
1. Parse into a normalised internal event.
2. Upsert/update the corresponding `Transaction`.
3. Hand to the Attribution Engine.
4. Advance intervention state if warranted (`OBSERVING → CONVERTED`).
5. Mark `processedAt`, or record `processingError` and leave it for the retry sweep.

MVP runs Stage 2 as an in-process async job triggered after persist, with a periodic sweep for anything left unprocessed — no queue infrastructure for a hackathon. The boundary is drawn so a real queue drops in later without touching Stage 1.

**Attribution logic**, in priority order:
1. **`DIRECT_REF`** (confidence HIGH) — the payment carries our `attributionRef`, embedded at creation time in the link's notes/reference field. Unambiguous.
2. **`WINDOW_MATCH`** (confidence MEDIUM) — same customer, amount within tolerance, inside the intervention's attribution window, and no competing intervention. Recorded as probable, and labelled as such in the UI.
3. **`UNATTRIBUTED`** — no confident match. This is a **valid, visible outcome**, not a failure to hide. Over-claiming credit would undermine the entire premise of the product.

Ordering is not assumed: events may arrive out of order or late. State transitions are written as idempotent upserts keyed on the event, so replay is safe.

**Local development** uses a tunnel (ngrok/cloudflared) plus a signed-request replay script, so webhook handling can be tested without waiting on real traffic.

---

## 10. Frontend pages

| Route | Purpose | Notes |
|---|---|---|
| `/` — Command centre | Live counters: opportunities open, awaiting approval, live interventions, recovered revenue | Test-mode banner always visible |
| `/opportunities` | Detected opportunities, sorted by recoverable value | "Run agent" trigger |
| `/opportunities/[id]` | Evidence view: affected customers, failure-reason breakdown, raw transactions | Numbers link to source rows |
| `/interventions` | Queue by state, with the approval inbox front and centre | |
| `/interventions/[id]` — **the decision packet** | The centrepiece. Recommended action; expected gross / cost / **net**; confidence; *alternatives considered and why they lost*; the agent's rationale; every guardrail check with observed-vs-limit; editable customer message; Approve / Reject with reason | This one screen is the demo |
| `/policies` | Guardrail editor with live "would this proposal still pass?" preview | Versioned, never mutated |
| `/audit` | Filterable event stream with chain-integrity indicator | Narrative, not a log dump |
| `/analytics` | Proposed → approved → executed → recovered funnel; per-playbook learned rates | Shows LEARN moving |

Server Components for data-heavy reads; client components only for interactive controls. Money is stored and computed in **paise as integers** and formatted only at the render boundary.

---

## 11. MVP scope

**In:**
- One detector: failed-payment recovery
- 2–3 playbooks (plain payment link, link with capped discount, reminder-only)
- Deterministic estimator with seeded priors
- LLM reasoner with schema validation, numeric-claim checking, and deterministic fallback
- Full guardrail engine with the ten MVP rules and two-phase evaluation
- Human approval with message editing, role gating, and optimistic locking
- Executor against Razorpay Test Mode, with a `FakeProvider` for offline demo
- Webhook ingest with signature verification and dedupe
- Attribution with `DIRECT_REF` and `WINDOW_MATCH`
- Hash-chained audit log with a verification endpoint
- The eight pages above
- Synthetic dataset seeder

**Out (say so plainly rather than half-build):** real merchant data connection, multi-channel sending infrastructure, scheduling/automation of the agent, multi-detector portfolio optimisation, override workflows, and any live-mode capability whatsoever.

---

## 12. Post-MVP scope

- **More detectors:** subscription churn signals, abandoned checkouts, settlement/refund anomalies, pricing and method-mix optimisation
- **Portfolio reasoning:** allocate a fixed budget across competing opportunities rather than scoring each in isolation
- **Real uplift modelling:** holdout groups and incremental-lift measurement, which is where a Python service genuinely earns its keep
- **Autonomy tiers:** merchant-configurable auto-approval below a value threshold, with post-hoc review and instant rollback
- **Multi-channel orchestration** with per-channel cost and response modelling
- **Policy simulation:** replay history against a candidate policy before adopting it
- **Live-mode readiness:** dual approval for high value, anomaly circuit breakers, compliance review

---

## 13. Testing strategy

The layering exists to make this cheap.

- **Unit (Vitest), the bulk.** Detectors, estimator, and guardrail engine are pure functions — table-driven tests over fixture datasets. Guardrails get exhaustive boundary tests: at the limit, one under, one over. Attribution gets ambiguity cases.
- **LLM contract tests.** Recorded fixture responses covering: valid output, malformed JSON, unknown playbook id, hallucinated figure, and empty response. Each must produce the correct fallback. **No test calls a live model.**
- **Integration.** Full state machine against `FakeProvider` and a test Postgres: propose → guardrail → approve → execute → webhook → attribute → learn. Plus the adversarial paths: double approval, execution failure and retry, duplicate webhook, out-of-order webhook, guardrail flip between approval and execution.
- **Webhook tests.** Signature valid / invalid / replayed / late-arriving, using recorded payload shapes.
- **Invariant tests.** Assertions that must hold across all flows: no `ExecutionAttempt` without an `Approval`; no state transition without an `AuditLog` row; audit chain verifies; no negative or non-integer money values.
- **E2E (Playwright).** The demo script itself, run in CI. If the demo path breaks, the build fails — the most valuable test we will write.
- **Seeded determinism.** Fixed random seed for synthetic data so every number in the demo is reproducible.

---

## 14. Failure modes

| Failure | Handling | Demo-visible? |
|---|---|---|
| LLM returns invalid schema | One repair attempt, then deterministic fallback | Yes — labelled `DETERMINISTIC_FALLBACK` |
| LLM hallucinates a figure | Numeric-claim check rejects the rationale | Yes — worth showing on purpose |
| LLM provider down / rate-limited | Circuit breaker → deterministic ranking; agent keeps working | Banner: "reasoning degraded" |
| Razorpay 5xx or timeout | Bounded backoff on the persisted idempotency key; `EXECUTION_FAILED` after exhaustion | Yes, with retry control |
| Crash between issue and response | Key persisted pre-call; retry reuses it; artifact lookup reconciles | No double action |
| Duplicate webhook | Unique event id → 200, no reprocessing | — |
| Out-of-order / late webhook | Idempotent upserts; attribution window tolerates lateness | — |
| Invalid webhook signature | Rejected, stored, alerted, never processed | Yes, if demoed deliberately |
| Two approvers race | Optimistic lock on `version`; loser gets a clear conflict message | Yes |
| Budget consumed between approval and execution | `PRE_EXECUTION` guardrail blocks with the changed rule named | **Yes — a strong demo beat** |
| Customer opts out post-approval | Same path, `DO_NOT_CONTACT` blocks | Yes |
| Attribution ambiguous | Recorded `UNATTRIBUTED` rather than credited | Yes — honesty is the feature |
| Detector produces zero opportunities | Empty state explains what was scanned and why nothing qualified | Yes |
| Database unavailable | Fail closed: no execution without a persisted approval | — |

**Graceful failure is a track criterion, so we should demo one deliberately** rather than hoping nothing breaks.

---

## 15. Security considerations

- **Secrets** server-side only, in the Razorpay module alone; never in client components, never in `NEXT_PUBLIC_*`. A CI check greps the client bundle for key patterns.
- **Webhook authenticity** by HMAC over the raw body, constant-time comparison, before any parsing.
- **Tenant isolation** enforced in a repository layer that injects `merchantId` into every query. Reviewed as a hard rule; a missing scope is a blocking defect.
- **RBAC:** `VIEWER` reads, `APPROVER` approves, `ADMIN` edits policy. Approval and policy routes check the role server-side, not just in the UI.
- **Prompt injection.** Customer-supplied text (names, notes, failure descriptions) is untrusted input to the LLM. Mitigated structurally: the LLM has **no tools, no execution path, and no authority over numbers** — the worst case of a successful injection is a bad *recommendation* that a human then reads and a deterministic guardrail then checks. Additionally: delimit and label untrusted spans in the prompt, and validate output against the allowed candidate set.
- **PII minimisation.** Store masked contact details; never log raw PII; no card data ever touches our database. Audit entries reference customers by id.
- **CSRF** on all mutating routes; **rate limiting** on approval, agent-run, and webhook endpoints.
- **Test-mode enforcement** at three levels: adapter construction, guardrail rule, and a persistent UI banner. There must be no code path to live mode in this build.
- **Dependency hygiene:** lockfile committed, `npm audit` in CI, no unvetted packages in the execution path.

---

## 16. End-to-end demo flow

Target: **four minutes**, reproducible, with a deliberate failure beat. Every step is backed by a route above.

**Setup (pre-recorded state):** merchant seeded with ~500 transactions, ~60 failed payments across realistic failure reasons, policy configured with a modest daily discount budget.

1. **Observe.** Open `/opportunities` and hit *Run agent*. The detector surfaces "23 recoverable failed payments — ₹1,84,000 at risk", with the evidence view showing the failure-reason breakdown. Point out: these are counted facts, not predictions.

2. **Reason.** Open the opportunity. Three playbooks are scored side by side with expected gross, cost, net, and confidence. Point out: **computed in TypeScript before the model was called.**

3. **Plan.** Open `/interventions/[id]` — the decision packet. The agent recommends the capped-discount payment link, explains why it beat the alternatives, and shows the drafted customer message. Point out: the model chose among *pre-scored* options and cannot invent a number.

4. **Guardrail.** The panel shows all ten checks with observed-vs-limit. Nine pass; `LOW_CONFIDENCE` returns `REQUIRE_APPROVAL`. Point out: bounded autonomy, and the reason is legible.

5. **The failure beat.** Lower the daily discount budget in `/policies`, return, and attempt approval. `PRE_EXECUTION` re-evaluation now **blocks**, naming the rule that changed. Nothing is sent. Point out: state drifts between approval and action, and we check twice. Restore the budget.

6. **Human approval.** Edit a line of the customer message, then approve. The audit log records the approver, the edit, and the timestamp.

7. **Act.** The executor calls Razorpay Test Mode with a persisted idempotency key and creates the payment link carrying our `attributionRef`. The artifact and its short URL appear in the UI.

8. **Verify.** Complete the payment in test mode (or trigger `/api/simulate/payment` if the venue network is unreliable). The webhook arrives, signature verifies, attribution resolves as `DIRECT_REF`, and the intervention moves to `CONVERTED` with **actual** recovered revenue recorded next to the estimate.

9. **Learn.** `/analytics` shows the playbook's success rate updating from its prior. Run the agent a second time and its estimates have shifted — the loop closes visibly.

10. **Audit.** `/audit` replays the entire decision as a narrative, with chain integrity verified. Close on: every rupee shown traces to a row, and no model output ever moved money on its own.

---

## 17. Recommended folder structure

```
revenuepilot/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ src/
│  ├─ app/
│  │  ├─ (dashboard)/                 # page routes from §10
│  │  └─ api/                         # route handlers from §4
│  ├─ components/
│  │  ├─ ui/                          # primitives
│  │  └─ domain/                      # DecisionPacket, GuardrailPanel, AuditTimeline…
│  ├─ core/                           # ← framework-free, no imports from app/
│  │  ├─ detectors/
│  │  ├─ estimator/
│  │  ├─ reasoner/                    # prompt building + output validation
│  │  ├─ guardrails/                  # rules/ + engine.ts
│  │  ├─ attribution/
│  │  ├─ learning/
│  │  ├─ orchestrator/                # state machine + transitions
│  │  └─ types/                       # money, Result, domain models
│  ├─ integrations/
│  │  ├─ razorpay/                    # adapter, fake, webhook verification
│  │  └─ llm/                         # provider client, retries, cost tracking
│  ├─ server/
│  │  ├─ repositories/                # tenant-scoped data access
│  │  ├─ audit/                       # append-only logger + chain verify
│  │  ├─ auth/
│  │  └─ db.ts
│  └─ lib/                            # money.ts, env.ts (validated), logger.ts
├─ analytics/                         # Python, offline only
│  ├─ generate_dataset.py
│  └─ calibrate_priors.py
├─ tests/
│  ├─ unit/  ├─ integration/  ├─ e2e/  └─ fixtures/
└─ docs/
   ├─ ARCHITECTURE.md
   ├─ DEMO_SCRIPT.md
   └─ RAZORPAY_NOTES.md               # verified-against-docs field mappings
```

The one rule that keeps this honest: **`src/core/` may not import from `src/app/` or `src/integrations/`.** Dependencies are injected. Enforced by an ESLint boundary rule.

---

## 18. Recommended tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router) + TypeScript strict | One deployable, RSC for data-heavy reads |
| Database | PostgreSQL 16 | Transactions, JSONB for raw payloads |
| ORM | Prisma | Typed schema, fast migrations |
| Validation | Zod | Same schemas for API input and LLM output |
| Styling | Tailwind + shadcn/ui | Credible UI at hackathon speed |
| Charts | Recharts | Funnel and learning curves |
| LLM | Claude — `claude-sonnet-5` default, `claude-opus-5` for hard cases | Strong structured output; latency matters on stage |
| Payments | Razorpay Test Mode via the adapter in §8 | |
| Testing | Vitest + Playwright | |
| Logging | Pino | Structured, redaction-aware |
| Hosting | Vercel + a managed Postgres (Neon/Supabase) | Public webhook URL out of the box |
| Offline analytics | Python 3.11 + pandas/numpy | Seed data and prior calibration only |

---

## 19. Likely packages

**Core:** `next` · `react` · `react-dom` · `typescript` · `@prisma/client` · `prisma` · `zod`
**LLM:** `@anthropic-ai/sdk`
**Payments:** `razorpay` (official Node SDK — final choice between SDK and typed `fetch` wrapper to be made against current docs)
**UI:** `tailwindcss` · `class-variance-authority` · `clsx` · `tailwind-merge` · `lucide-react` · `@radix-ui/*` (via shadcn) · `recharts` · `sonner`
**Data/state:** `@tanstack/react-query` (client-side mutations) · `date-fns` · `date-fns-tz` (quiet hours)
**Auth:** `next-auth` (or a minimal credentials session for demo simplicity — decide in Phase 0)
**Infra:** `pino` · `pino-pretty` · `nanoid` · `p-retry` · `@upstash/ratelimit` (or an in-memory limiter)
**Dev/test:** `vitest` · `@vitest/coverage-v8` · `@playwright/test` · `tsx` · `@faker-js/faker` · `eslint` · `prettier` · `eslint-plugin-boundaries`
**Python (offline):** `pandas` · `numpy` · `scipy` · `faker`

---

## 20. Implementation phases

Sequenced so that a **working, demoable product exists from Phase 4 onward** and everything after that increases quality rather than adding required parts.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0 — Foundation** | Next.js + TS + Prisma + Postgres, env validation, auth, tenant scoping, ESLint boundaries, CI | `npm test` green; a seeded merchant renders |
| **1 — Data & observation** | Synthetic dataset (Python), seeder, `Transaction`/`Customer` models, failed-payment detector, opportunity pages | Opportunities detected from seed data with correct totals |
| **2 — Deterministic core** | Estimator, playbooks, seeded priors, guardrail engine + all ten rules, audit logger with hash chain | Full propose→guardrail flow with **no LLM involved** |
| **3 — Reasoning** | LLM adapter, prompt construction, schema + numeric-claim validation, fallback path, `LlmCall` recording | Contract tests pass, including every malformed-output case |
| **4 — Human gate & execution** | Decision packet UI, approval/rejection, optimistic locking, executor with idempotency, `FakeProvider` | **End-to-end loop demoable against the fake provider** |
| **5 — Razorpay integration** | Real adapter against current docs, test-mode assertions, field mappings recorded in `RAZORPAY_NOTES.md` | Payment link created in Test Mode |
| **6 — Events & attribution** | Webhook receive/process split, signature verification, dedupe, attribution engine | Real webhook → `CONVERTED` with `DIRECT_REF` |
| **7 — Learning & analytics** | `PlaybookStat` updates, analytics page, funnel metrics | Second agent run shows shifted estimates |
| **8 — Demo hardening** | Playwright demo test in CI, simulation endpoint, empty/error states, offline fallback path, polish | Demo script runs green, twice, from a clean seed |

**Critical-path risk:** Phase 5 is the only phase with an external unknown. Phase 4's `FakeProvider` exit criterion is what protects us — if Razorpay integration proves fiddly, we still have a complete, honest demo, and we say plainly which provider it ran against.
