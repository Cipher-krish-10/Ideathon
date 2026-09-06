import { describe, expect, it } from "vitest";

import { amountsMatch, attributePayment } from "@/core/attribution";
import type {
  AttributionCandidate, AttributionConfig, NormalisedPayment,
} from "@/core/attribution";
import {
  normaliseWebhookEvent, signWebhookBody, verifyWebhookSignature,
} from "@/integrations/razorpay";

const CONFIG: AttributionConfig = { attributionWindowDays: 14, amountToleranceBps: 100 };
const EXECUTED_AT = new Date("2026-09-01T10:00:00Z");
const PAID_AT = new Date("2026-09-02T10:00:00Z");

function candidate(overrides: Partial<AttributionCandidate> = {}): AttributionCandidate {
  return {
    interventionId: "int_1", attributionRef: "rp_aaa", playbookId: "pb_1",
    state: "OBSERVING", executedAt: EXECUTED_AT,
    artifacts: [{
      providerEntityId: "plink_1", referenceId: "rp_aaa_t1",
      amountPaise: 100_000, transactionId: "txn_1", customerId: "cus_1",
    }],
    alreadyAttributedTransactionIds: [],
    ...overrides,
  };
}

function payment(overrides: Partial<NormalisedPayment> = {}): NormalisedPayment {
  return {
    providerPaymentId: "pay_1", amountPaise: 100_000, currency: "INR",
    occurredAt: PAID_AT, referenceId: "rp_aaa_t1", attributionRef: "rp_aaa",
    providerPaymentLinkId: "plink_1", ...overrides,
  };
}

describe("attribution engine", () => {
  describe("DIRECT_REF", () => {
    it("credits a payment carrying a reference we minted", () => {
      const decision = attributePayment(payment(), [candidate()], CONFIG);
      expect(decision.attributed).toBe(true);
      if (!decision.attributed) return;
      expect(decision.method).toBe("DIRECT_REF");
      expect(decision.confidence).toBe("HIGH");
      expect(decision.interventionId).toBe("int_1");
      expect(decision.transactionId).toBe("txn_1");
      // The verified amount, never our estimate.
      expect(decision.attributedAmountPaise).toBe(100_000);
    });

    it("uses the amount the provider reported, even if it differs slightly", () => {
      const decision = attributePayment(payment({ amountPaise: 100_500 }), [candidate()], CONFIG);
      expect(decision.attributed).toBe(true);
      if (!decision.attributed) return;
      expect(decision.attributedAmountPaise).toBe(100_500);
    });

    it("refuses when the reference matches but the amount does not", () => {
      const decision = attributePayment(payment({ amountPaise: 250_000 }), [candidate()], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("AMOUNT_MISMATCH");
    });

    it("does not steal attribution from another intervention's reference", () => {
      // The payment names someone else's reference.
      const decision = attributePayment(
        payment({ referenceId: "rp_bbb_t9", attributionRef: "rp_bbb" }), [candidate()], CONFIG,
      );
      expect(decision.attributed).toBe(false);
    });

    it("refuses a transaction already credited", () => {
      const decision = attributePayment(
        payment(), [candidate({ alreadyAttributedTransactionIds: ["txn_1"] })], CONFIG,
      );
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("ALREADY_ATTRIBUTED");
    });

    it("falls back to notes when the link reference is absent", () => {
      const decision = attributePayment(payment({ referenceId: null }), [candidate()], CONFIG);
      expect(decision.attributed).toBe(true);
      if (!decision.attributed) return;
      expect(decision.method).toBe("DIRECT_REF");
    });

    it("refuses when notes identify the intervention but not the target", () => {
      // Two targets share the amount; picking one would be a coin flip.
      const ambiguous = candidate({
        artifacts: [
          { providerEntityId: "p1", referenceId: "rp_aaa_t1", amountPaise: 100_000, transactionId: "txn_1", customerId: "cus_1" },
          { providerEntityId: "p2", referenceId: "rp_aaa_t2", amountPaise: 100_000, transactionId: "txn_2", customerId: "cus_2" },
        ],
      });
      const decision = attributePayment(payment({ referenceId: null }), [ambiguous], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("AMBIGUOUS_COMPETING_INTERVENTIONS");
    });
  });

  describe("WINDOW_MATCH", () => {
    const noRef = () => payment({ referenceId: null, attributionRef: null });

    it("credits a single unambiguous circumstantial match", () => {
      const decision = attributePayment(noRef(), [candidate()], CONFIG);
      expect(decision.attributed).toBe(true);
      if (!decision.attributed) return;
      expect(decision.method).toBe("WINDOW_MATCH");
      // Probable, and labelled as such.
      expect(decision.confidence).toBe("MEDIUM");
    });

    it("refuses when two interventions could each explain the payment", () => {
      const other = candidate({ interventionId: "int_2", attributionRef: "rp_bbb" });
      const decision = attributePayment(noRef(), [candidate(), other], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("AMBIGUOUS_COMPETING_INTERVENTIONS");
    });

    it("refuses a payment outside the attribution window", () => {
      const late = payment({
        referenceId: null, attributionRef: null,
        occurredAt: new Date(EXECUTED_AT.getTime() + 20 * 86_400_000),
      });
      const decision = attributePayment(late, [candidate()], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("OUTSIDE_ATTRIBUTION_WINDOW");
    });

    it("refuses a payment that predates the intervention", () => {
      // A link cannot have caused a payment made before it existed.
      const early = payment({
        referenceId: null, attributionRef: null,
        occurredAt: new Date(EXECUTED_AT.getTime() - 3_600_000),
      });
      expect(attributePayment(early, [candidate()], CONFIG).attributed).toBe(false);
    });

    it("refuses when the amount is outside tolerance", () => {
      const decision = attributePayment(
        payment({ referenceId: null, attributionRef: null, amountPaise: 150_000 }),
        [candidate()], CONFIG,
      );
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("AMOUNT_MISMATCH");
    });

    it("accepts an amount inside tolerance", () => {
      // 1% of ₹1,000 is ₹10.
      expect(amountsMatch(100_999, 100_000, 100)).toBe(true);
      expect(amountsMatch(101_001, 100_000, 100)).toBe(false);
    });
  });

  describe("UNATTRIBUTED", () => {
    it("refuses when there is no candidate at all", () => {
      const decision = attributePayment(payment(), [], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.reason).toBe("NO_CANDIDATE_INTERVENTION");
    });

    it("always explains itself", () => {
      const decision = attributePayment(payment({ amountPaise: 999 }), [candidate()], CONFIG);
      expect(decision.attributed).toBe(false);
      if (decision.attributed) return;
      expect(decision.detail.length).toBeGreaterThan(20);
      expect(decision.consideredInterventionIds).toContain("int_1");
    });

    it("is deterministic", () => {
      const a = JSON.stringify(attributePayment(payment(), [candidate()], CONFIG));
      const b = JSON.stringify(attributePayment(payment(), [candidate()], CONFIG));
      expect(a).toBe(b);
    });
  });
});

describe("webhook signature verification", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ event: "payment_link.paid" });

  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(body, signWebhookBody(body, secret), secret)).toBe(true);
  });

  it("rejects a wrong signature, a wrong secret, and a tampered body", () => {
    const signature = signWebhookBody(body, secret);
    expect(verifyWebhookSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, "other_secret")).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
  });

  it("rejects a missing signature or secret", () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signWebhookBody(body, secret), "")).toBe(false);
  });
});

describe("webhook normalisation", () => {
  const paidEvent = {
    entity: "event", event: "payment_link.paid", created_at: 1_788_000_000,
    payload: {
      payment_link: {
        entity: {
          id: "plink_1", reference_id: "rp_aaa_t1", amount: 100_000,
          amount_paid: 100_000, status: "paid",
          notes: { attribution_ref: "rp_aaa" },
        },
      },
      payment: {
        entity: { id: "pay_1", amount: 100_000, currency: "INR", status: "captured", notes: {} },
      },
    },
  };

  it("normalises payment_link.paid", () => {
    const event = normaliseWebhookEvent(paidEvent);
    expect(event.type).toBe("PAYMENT_LINK_PAID");
    expect(event.isSuccessfulPayment).toBe(true);
    expect(event.payment?.providerPaymentId).toBe("pay_1");
    // reference_id lives on the payment link, not the payment.
    expect(event.payment?.referenceId).toBe("rp_aaa_t1");
    expect(event.payment?.attributionRef).toBe("rp_aaa");
    expect(event.payment?.amountPaise).toBe(100_000);
  });

  it("does not treat an unpaid link as a successful payment", () => {
    const event = normaliseWebhookEvent({
      ...paidEvent,
      payload: {
        ...paidEvent.payload,
        payment_link: { entity: { ...paidEvent.payload.payment_link.entity, status: "created" } },
      },
    });
    expect(event.isSuccessfulPayment).toBe(false);
  });

  it("treats payment.failed as unsuccessful", () => {
    const event = normaliseWebhookEvent({ ...paidEvent, event: "payment.failed" });
    expect(event.type).toBe("PAYMENT_FAILED");
    expect(event.isSuccessfulPayment).toBe(false);
  });

  it("marks an unknown event UNSUPPORTED rather than guessing", () => {
    const event = normaliseWebhookEvent({ entity: "event", event: "refund.created" });
    expect(event.type).toBe("UNSUPPORTED");
    expect(event.isSuccessfulPayment).toBe(false);
  });

  it("survives a malformed payload without throwing", () => {
    for (const payload of [{}, null, { event: "payment_link.paid" }, { payload: {} }]) {
      expect(() => normaliseWebhookEvent(payload)).not.toThrow();
    }
    expect(normaliseWebhookEvent({ event: "payment_link.paid" }).isSuccessfulPayment).toBe(false);
  });

  it("handles notes sent as an empty array", () => {
    // Razorpay sends `notes: []` when there are none.
    const event = normaliseWebhookEvent({
      ...paidEvent,
      payload: {
        ...paidEvent.payload,
        payment_link: { entity: { ...paidEvent.payload.payment_link.entity, notes: [] } },
      },
    });
    expect(event.payment?.attributionRef).toBeNull();
  });
});
