# RevenuePilot — Demo Script

**Runtime:** ~5 minutes. **Mode:** Razorpay Test Mode. **No money is recovered in this demo** — a payment link is created and left awaiting payment. Attribution is Phase 6.

---

## 0. Setup (before you present)

```bash
npm run db:seed          # restore the approved dataset
npm run demo:setup       # detector → estimator → reasoner → guardrails
npm run dev              # http://localhost:3000
```

**Execution provider.** `PAYMENT_PROVIDER` defaults to `fake`, which creates realistic
artifacts with no external call — fine for rehearsal. For **real Razorpay Test Mode**, add
all three to `.env` (the adapter refuses to start without every one of them):

```bash
PAYMENT_PROVIDER="razorpay"
RAZORPAY_KEY_ID="rzp_test_..."
RAZORPAY_KEY_SECRET="..."
RAZORPAY_MODE="test"
```

Verify before presenting: `PAYMENT_PROVIDER=razorpay npm run razorpay:smoke`

`demo:setup` prints the decision packet URL.

**For a reproducible run, use the fixture:**
```bash
npm run db:seed && npm run demo:setup -- --scripted
```
Everything except the model is deterministic. With a **live** LLM key the recommendation
may differ run to run — and the model may be *rejected*: on one live Groq run the first
attempt hallucinated a figure, the repair overclaimed confidence, and the system fell back
deterministically. That is the validator working, but it is not something to leave to
chance in front of judges. Rehearse with `--scripted`; show the live model as a separate,
deliberate beat.

> **Why a setup step exists.** Under the *seeded* policy v1, the highest-net candidate is **blocked at proposal**: its discount cost of ₹25,331.91 exceeds the ₹25,000.00 daily discount budget by ₹331.91. That is a correct evaluation, not a bug — but it means nothing reaches a human. `demo:setup` raises the budget to ₹30,000 (creating policy v2) so the proposal reaches the approval queue. Lowering it again is the failure beat.

**With no LLM key**, the reasoner falls back deterministically and labels the proposal `DETERMINISTIC_FALLBACK` — itself a good beat. **With `GROQ_API_KEY` or `ANTHROPIC_API_KEY` set**, a real model reasons over the candidates.

---

## 1. Command Centre — the observation *(30s)*

Open `/`.

- **₹5,14,274.00 recoverable**, **26 qualifying customers**
- Point at the label: *"Potential — not yet recovered."* Recovered revenue reads **₹0.00**, because nothing has executed.
- The **TEST MODE** banner is always on screen.

> "Every figure here was computed deterministically from 1,200 transactions and 1,223 payment attempts. None of it came from a model."

---

## 2. Opportunity — the discrimination *(40s)*

Open `/opportunities` → **View evidence**.

- **Why these qualified**: failure-reason breakdown.
- **Why the rest did not** — the important table:

| Exclusion | Count |
|---|---|
| ALREADY_RECOVERED | 1134 |
| NON_RECOVERABLE_FAILURE | 12 |
| OUTSIDE_RECENCY_WINDOW | 10 |
| BELOW_TICKET_FLOOR | 6 |
| BELOW_LTV_FLOOR | 6 |
| SUPPRESSED | 6 |

> "66 failed transactions exist. Only 26 qualify. The agent rejected 40 for five distinct reasons — it discriminated, it didn't just count failures."

---

## 3. Deterministic strategies *(30s)*

Same page, **Deterministic strategies**:

| Playbook | Recovery | Expected net | Confidence |
|---|---|---|---|
| Plain retry reminder | 28.36% | ₹1,42,921.20 | MEDIUM |
| Payment link, no incentive | 39.79% | ₹2,00,508.37 | MEDIUM |
| Payment link + 10% offer | 49.26% | ₹2,23,414.04 | MEDIUM |

> "Three options, scored in TypeScript, before any model was consulted. Confidence is MEDIUM everywhere because the priors are seeded calibration with zero real outcomes — the system will not claim more than it has earned."

---

## 4. Decision Packet — the AI recommendation *(60s)*

Open the intervention. Walk the sections top to bottom.

- **AI Recommendation** — selected playbook, rationale, risks, confidence note.
- **Alternatives considered** — all three, selected row highlighted.

> "The model chose among pre-scored options. It cannot compute a number: the output schema has no numeric field at all, and every figure in that rationale is checked against the estimator's output before it is shown to you."

**Optional beat — show the model being caught:**
```bash
psql -d revenuepilot -c 'SELECT "attemptNo","isValid","validationOutcome" FROM llm_call ORDER BY "attemptNo";'
```
On a live Groq run the first attempt is often rejected (`CONFIDENCE_OVERCLAIM` or `NUMERIC_HALLUCINATION`), repaired, then accepted. The rejection is stored deliberately.

---

## 5. Guardrails *(40s)*

Scroll to **Guardrails — pre approval**. Ten rules, each with **observed vs limit**.

> "This is the deterministic layer, and it is authoritative. The model may cite these limits; it cannot change them. Quiet hours shows REQUIRE_APPROVAL rather than BLOCK — a scheduling question a human answers, not a prohibition."

---

## 6. Edit and approve *(30s)*

- Edit the **subject** line in the customer message.
- Point out: *"Text only. Financial parameters aren't editable here — changing them would invalidate the guardrail evaluation."*
- Click **APPROVE**.

Green banner: **Approved — No money has moved.**

Reload: state is `APPROVED`, controls are gone, the audit timeline has grown.

> "A human approved. Nothing was sent. There is no payment provider in this codebase yet — and the database itself refuses any execution state without an approval row."

---

## 7. Execute — Razorpay Test Mode *(50s)*

The **Execution** card now reads **READY TO EXECUTE**.

> "Approval was a human saying yes. It is not permission to skip the last check — the
> executor re-runs the pre-execution guardrails against current state before anything
> leaves the building."

Click **EXECUTE**.

**Green banner:** *Executed — payment link(s) created in Razorpay Test Mode.*
> **Payment link created — revenue has NOT yet been recovered.**

The artifact table appears: **Razorpay Test Payment Link** (short URL), amount, status
**awaiting payment**, and the provider id (`plink_…`). The intervention is now `OBSERVING`.

**Open the short URL** in a new tab to show a real Razorpay Test Mode checkout page.
**Stop there.** Do not complete the payment as part of this phase's story — and if you do,
say plainly that nothing in RevenuePilot has noticed yet, because webhook ingestion and
attribution are Phase 6.

Point at the **Execution attempts** list: each attempt carries its own idempotency key,
persisted *before* the call went out.

> "If that response had been lost, we would not create a second link. The executor asks
> Razorpay whether the first one landed, using the reference id, before it retries."

Now return to `/` — **Executed actions** is 1, **Payment links created** is 1, value
awaiting payment is non-zero, and **Recovered revenue is still ₹0.00.**

> "Executed means the action exists at Razorpay. It does not mean the merchant got paid.
> Recovered revenue moves only when a real payment event confirms it — and that is the
> next phase."

---

## 8. THE FAILURE BEAT — guardrails block a real approval *(50s)*

This is the strongest moment. **Reset first:**

```bash
npm run db:seed && npm run demo:setup
```

1. Open the decision packet. **Guardrails — pre approval: PASS/REQUIRE_APPROVAL.**
2. Go to **Policies**. Lower `DAILY_DISCOUNT_BUDGET_PAISE` from `3000000` to `2000000` (₹30,000 → ₹20,000). **Save as new version** → *"Saved as policy version 3."*
3. Return to the decision packet. Click **APPROVE**.

**Red banner:**

> **Action blocked**
> `DAILY_DISCOUNT_BUDGET_PAISE` — Committed ₹0.00 plus this action's ₹25,331.91 would reach ₹25,331.91, over the ₹20,000.00 daily budget.
> Nothing was sent and no money moved.

Reload — the packet now shows **two** guardrail tables that disagree: `PRE_APPROVAL` passed, `PRE_EXECUTION` blocked. State is `GUARDRAIL_BLOCKED`, and **no Approval row was created**.

> "The state a merchant reviews is not always the state that exists when they click. Budget gets consumed, consent gets withdrawn. So we evaluate twice — once to show you, once immediately before acting. That gap is exactly how an agent does something nobody meant."

**Restore:** `npm run db:seed && npm run demo:setup`

Shortcut for rehearsal — lands directly in the blocked state:
```bash
npm run db:seed && npm run demo:setup -- --block
```

---

## 9. Audit *(20s)*

Open `/audit`.

> **Integrity verified** — N entries recomputed from scratch.

> "Append-only and hash-chained. Each entry commits to its predecessor, so editing history invalidates everything after it. The database rejects UPDATE outright and rejects DELETE without an explicit session flag."

---

## Closing line

> "Data → opportunity → deterministic options → AI recommendation → guardrails → human
> approval → execution in Razorpay Test Mode. The model reasoned about the trade-off and
> explained it. It never computed a rupee, never chose an action it wasn't offered, and
> never got past a human. A payment link now exists and is awaiting payment — and until a
> real payment event says otherwise, recovered revenue stays at zero."

---

## Other failure paths worth showing

| Beat | How |
|---|---|
| Model unavailable | Unset `GROQ_API_KEY`, `npm run demo:setup` → `DETERMINISTIC_FALLBACK`, labelled in the UI |
| Model hallucinates a figure | `npm run reasoner -- --scripted` variants; rejections stored in `llm_call` |
| Prompt injection | `npm run reasoner -- --inject` — untrusted text is fenced; the model cannot select an unoffered action |
| Blocked at proposal | `npm run db:seed && npm run detector` then run the agent without `demo:setup` — policy v1 blocks the offer by ₹331.91 |
| Stale version | Open the packet in two tabs, approve in one, then approve in the other → 409 with a reload prompt |

## Verification

```bash
npm run verify      # typecheck, lint, 344 tests, DB checks
npm run test:e2e    # 11 Playwright tests, including execution and the failure beat
npm run razorpay:smoke                       # config check (fake by default)
PAYMENT_PROVIDER=razorpay npm run razorpay:smoke   # one real Test Mode link
```

**Phase boundary.** Execution ends at a payment link in `created` status. Webhook
ingestion, payment confirmation, and revenue attribution are **Phase 6**. Nothing in this
build claims a rupee was recovered.
