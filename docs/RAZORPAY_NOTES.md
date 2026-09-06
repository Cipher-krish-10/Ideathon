# Razorpay Integration Notes

**Verified against official documentation on 2026-09-06.** Every field below was read from the live docs, not inferred. Anything undocumented is called out as such and is never relied on to *permit* an action.

---

## 1. Endpoints used

| Purpose | Method | URL | Source |
|---|---|---|---|
| Create Standard Payment Link | `POST` | `https://api.razorpay.com/v1/payment_links` | [create-standard](https://razorpay.com/docs/api/payments/payment-links/create-standard/) |
| Reconcile after ambiguous failure | `GET` | `https://api.razorpay.com/v1/payment_links?reference_id=<ref>` | [fetch-all-standard](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/) |

**Authentication:** HTTP Basic — `Authorization: Basic base64(KEY_ID:KEY_SECRET)`. [Source](https://razorpay.com/docs/api/authentication/)

**Why raw `fetch` rather than the Node SDK.** The REST field contract is what I verified, so calling it directly means the code matches the documentation exactly, with no SDK version whose serialisation I would be guessing at. It also keeps the dependency surface at zero for the one module that holds credentials. The `PaymentProvider` interface is unchanged either way, so swapping in the SDK later touches one file.

---

## 2. Field mappings — create payment link

| Our field | Razorpay field | Type | Purpose | Verified |
|---|---|---|---|---|
| `amountPaise` (minus discount) | `amount` | integer | Amount in the **smallest currency unit** — paise for INR. Our money is already integer paise, so this is a direct pass-through with no conversion. Minimum ₹1.00 = `100`. | 2026-09-06 |
| `currency` (`"INR"`) | `currency` | string | Three-letter ISO code. Defaults to INR if omitted; we send it explicitly. | 2026-09-06 |
| `description` | `description` | string, ≤2048 | Short human description of what the link is for. | 2026-09-06 |
| `InterventionTarget.perTargetRef` | `reference_id` | string, ≤40 | **"Reference number tagged to a Payment Link. Must be a unique number."** This is our attribution anchor *and* our idempotency anchor — see §4. | 2026-09-06 |
| `Intervention.attributionRef`, ids | `notes` | object, ≤15 pairs | **"Key-value pair that can be used to store additional information."** Carries `attribution_ref`, `intervention_id`, `target_ref`, `source`. | 2026-09-06 |
| `expiresAt` | `expire_by` | integer | **Unix timestamp** (seconds) at which the link expires. | 2026-09-06 |
| — | `notify.sms` / `notify.email` | boolean | Whether Razorpay sends the notification. **We send `false` for both.** RevenuePilot is a demo working from masked contact data; having the provider message real people is not something a hackathon build should be able to do. | 2026-09-06 |
| — | `reminder_enable` | boolean | We send `false`, for the same reason. | 2026-09-06 |

### Deliberately NOT sent

| Field | Why |
|---|---|
| `customer.name` / `customer.email` / `customer.contact` | The dataset holds only **masked** contact details (`ta*****@outlook.com`, `+91*****4820`). Sending a mask would be sending junk; sending real PII is not something this build has, or wants. Customer identity travels in `notes` as an internal reference only. |
| `callback_url` / `callback_method` | Not needed until the webhook phase. |
| `accept_partial` / `first_min_partial_amount` | Partial payments would complicate attribution; out of MVP scope. |

---

## 3. Response fields consumed

| Razorpay field | Our field | Notes |
|---|---|---|
| `id` | `RazorpayArtifact.providerEntityId` | e.g. `plink_ERgihyaAAC0VNW` |
| `short_url` | `RazorpayArtifact.shortUrl` | The link a customer opens |
| `amount` | `RazorpayArtifact.amountPaise` | Echoed back in paise |
| `status` | `RazorpayArtifact.status` | One of `created`, `partially_paid`, `paid`, `expired`, `cancelled` |
| `reference_id` | verified against our `perTargetRef` | Mismatch is treated as a malformed response |
| `notes` | stored in `raw` | |

> **`status: "created"` means the link exists — nothing more.** It is not payment, and not recovered revenue. The UI says so explicitly.

---

## 4. Idempotency — application-level, by necessity

**Razorpay does not document an idempotency header for Payment Links.** The documented mechanisms are `X-Payout-Idempotency` (RazorpayX Payouts) and `X-Refund-Idempotency` (instant refunds). Neither applies here. [Source](https://razorpay.com/docs/api/x/payout-idempotency/make-request/)

Sending an undocumented header and *assuming* it protects us would be worse than having no protection, because it would look protected. So idempotency is enforced application-side:

1. **`reference_id` must be unique** (documented). We use `InterventionTarget.perTargetRef`, which is stable across retries — a retry sends the *same* reference, not a new one.
2. **The `ExecutionAttempt` row, with its idempotency key, is persisted BEFORE the call is issued.** A crash between issue and response leaves evidence that the call may have happened.
3. **Ambiguous failures reconcile before retrying.** On a timeout or 5xx, the executor first calls `GET /v1/payment_links?reference_id=<ref>`. If a link already exists for that reference, it is adopted rather than re-created.

That third step is the one that matters: **a lost response must never cause a second payment link.**

---

## 5. Test-mode enforcement

**Razorpay does not document a key-prefix convention for distinguishing test from live keys.** The docs say only to "Select the mode (Test or Live) for which you want to generate the API key". There is no documented programmatic way to tell them apart.

So the mode gate is **explicit application configuration, failing closed**:

| Layer | Mechanism |
|---|---|
| 1 | `RAZORPAY_MODE` must be **explicitly** set to `test`. There is no default. Absent or any other value → the adapter refuses to construct. |
| 2 | `PAYMENT_PROVIDER` must be explicitly `razorpay` for real calls; the default is `fake`. |
| 3 | Credentials must both be present, or the adapter refuses to construct. |
| 4 | The `TEST_MODE_ONLY` guardrail re-asserts `Merchant.mode === "TEST"` on every evaluation. |
| 5 | The UI shows a permanent TEST MODE banner, and offers no control to change it. |
| 6 | **Defence in depth:** a key id beginning `rzp_live_` is refused outright. This is an *observed* convention, not a documented one, so it is used **only to refuse, never to permit** — it can make the gate stricter and can never make it looser. |

There is no code path that reaches live mode. `Merchant.mode` has no UI or API that sets it to `LIVE`.

---

## 6. Error handling

| Condition | Behaviour |
|---|---|
| Network error / timeout | **Reconcile by `reference_id` first**, then retry with bounded backoff |
| `5xx` | Reconcile, then retry (bounded) |
| `429` | Retry with backoff — transient by definition |
| `4xx` (400, 401, 403, 404) | **Never retried.** A validation or auth error will not resolve by asking again |
| Malformed response | Treated as failure; no artifact is persisted from a response we cannot verify |
| Duplicate `reference_id` | Reconciled to the existing link rather than treated as an error |

Razorpay error responses carry `error.code`, `error.description`, `error.reason`. We surface `description` for the operator and store the whole body in the attempt record.

---

## 7. What is deliberately not implemented yet

Webhooks · signature verification · attribution · payment capture. Phase 6.

A payment link in `created` status is the end of Phase 5. **No revenue has been recovered at that point**, and nothing in the UI or the metrics says otherwise.
