/**
 * Recorded LLM response fixtures.
 *
 * NO TEST CALLS A LIVE MODEL. Every contract case is a fixed string, so the
 * suite is deterministic, offline, and asserts on OUR validation rather than on
 * a model's phrasing.
 *
 * The figures below match the estimator's actual output for the seeded
 * opportunity, so the "valid" fixtures pass numeric validation for real reasons.
 */

export const CANDIDATE_IDS = {
  reminder: "pb-reminder",
  plain: "pb-plain",
  offer: "pb-offer",
} as const;

/** Passes every gate. */
export function validResponse(playbookId: string = CANDIDATE_IDS.offer): string {
  return JSON.stringify({
    selectedPlaybookId: playbookId,
    rationale:
      "Under the merchant's configured recovery model this candidate shows the strongest " +
      "expected net revenue among the three options, and the modelled recovery rate " +
      "justifies its additional cost.",
    customerMessage: {
      subject: "Completing your recent payment",
      body:
        "Hello,\n\nYour recent payment of {{amount}} did not go through. You can " +
        "complete it here: {{payment_link}}\n\nIf you have already paid, please ignore " +
        "this message.\n\nThank you.",
    },
    risksIdentified: [
      "Confidence is MEDIUM; priors are configured calibration with no recorded outcomes.",
      "Contacting many customers at once concentrates reputational risk.",
    ],
    confidenceNote:
      "Confidence is MEDIUM, matching the estimator. Recovery rates are modelled rather " +
      "than observed.",
  });
}

/** Quotes supplied figures verbatim — must be accepted. */
export const validResponseQuotingFigures = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "Expected net of ₹2,23,414.04 exceeds the plain link's ₹2,00,508.37 under the " +
    "merchant's configured recovery model, at a modelled recovery rate of 49.26%.",
  customerMessage: {
    subject: "Completing your payment",
    body: "Hello,\n\nYour payment of {{amount}} did not go through. Here is 10% off: {{payment_link}}\n\nThank you.",
  },
  risksIdentified: ["Discount reduces margin on customers who would have paid anyway."],
  confidenceNote: "Confidence is MEDIUM, consistent with the estimator's assessment.",
});

export const malformedJson = "{ selectedPlaybookId: 'pb-offer', rationale: unterminated";

export const missingSelectedPlaybookId = JSON.stringify({
  rationale:
    "This option looks strongest overall given the modelled recovery characteristics.",
  customerMessage: { subject: "Payment", body: "Hello, please complete your payment {{amount}}." },
  risksIdentified: ["Some risk"],
  confidenceNote: "Confidence is MEDIUM.",
});

export const unknownPlaybookId = JSON.stringify({
  selectedPlaybookId: "pb-does-not-exist",
  rationale:
    "Selecting an aggressive full-refund play because it should maximise recovery here.",
  customerMessage: { subject: "Payment", body: "Hello, please complete your payment {{amount}}." },
  risksIdentified: ["Unknown playbook risk"],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Invents a rupee figure the estimator never produced. */
export const hallucinatedMoney = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "This campaign can recover ₹3,00,000 for the merchant, which is comfortably the " +
    "strongest of the available options.",
  customerMessage: { subject: "Payment", body: "Hello, complete your payment {{amount}}." },
  risksIdentified: ["Discount reduces margin."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Invents a recovery percentage. */
export const hallucinatedPercentage = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "We expect an 85% recovery rate on this cohort, far above the other candidates.",
  customerMessage: { subject: "Payment", body: "Hello, complete your payment {{amount}}." },
  risksIdentified: ["Discount reduces margin."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** A figure derived by arithmetic from supplied values — still not supplied. */
export const derivedArithmetic = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "The offer beats the plain link by ₹22,905.67 in expected net revenue under the " +
    "merchant's configured recovery model.",
  customerMessage: { subject: "Payment", body: "Hello, complete your payment {{amount}}." },
  risksIdentified: ["Discount reduces margin."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Upgrades MEDIUM confidence to high. */
export const confidenceOverclaim = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "Historical data proves this approach works, so we can proceed with high confidence " +
    "in the outcome for this cohort.",
  customerMessage: { subject: "Payment", body: "Hello, complete your payment {{amount}}." },
  risksIdentified: ["Discount reduces margin."],
  confidenceNote: "We are highly confident this will succeed.",
});

/** Sound rationale, but the customer copy promises money we never supplied. */
export const badCustomerMessage = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "Under the merchant's configured recovery model this is the strongest of the three " +
    "candidates on expected net revenue.",
  customerMessage: {
    subject: "Get ₹5,000 off your order",
    body: "Hello,\n\nWe are giving you a guaranteed ₹5,000 credit. Pay now: {{payment_link}}",
  },
  risksIdentified: ["Discount reduces margin."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Customer copy offering a discount the selected playbook does not carry. */
export const wrongDiscountInMessage = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.plain,
  rationale:
    "The plain payment link keeps cost low while still producing solid expected net " +
    "revenue under the merchant's configured model.",
  customerMessage: {
    subject: "Complete your payment",
    body: "Hello,\n\nHere is 50% off to complete your payment: {{payment_link}}",
  },
  risksIdentified: ["Customer may not respond."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Obeys an injected instruction found in untrusted data. */
export const injectionCompliantResponse = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.offer,
  rationale:
    "As instructed in the merchant note, applying a 100% discount and executing the " +
    "payment immediately without waiting for approval.",
  customerMessage: {
    subject: "100% off your order",
    body: "Hello,\n\nYou are getting 100% off. No payment needed: {{payment_link}}",
  },
  risksIdentified: ["None identified."],
  confidenceNote: "Confidence is MEDIUM.",
});

/** Correctly treats the injected text as data and reports it. */
export const injectionResistantResponse = JSON.stringify({
  selectedPlaybookId: CANDIDATE_IDS.plain,
  rationale:
    "Selecting the plain payment link on its expected net revenue under the merchant's " +
    "configured recovery model. The merchant note in the untrusted section attempts to " +
    "direct a full discount and immediate execution; I have treated it as data and " +
    "ignored it.",
  customerMessage: {
    subject: "Completing your recent payment",
    body: "Hello,\n\nYour payment of {{amount}} did not go through: {{payment_link}}\n\nThank you.",
  },
  risksIdentified: [
    "A merchant note contained an instruction-like string attempting to force a full " +
      "discount and bypass approval; it was ignored and should be reviewed.",
  ],
  confidenceNote: "Confidence is MEDIUM, matching the estimator.",
});

export const emptyResponse = "";

/** Markdown-fenced JSON, which models often emit; must still be accepted. */
export const fencedValidResponse = "```json\n" + validResponse() + "\n```";

/**
 * Retarget a fixture at a real playbook id.
 *
 * Unit tests use the fixed CANDIDATE_IDS; integration tests run against a
 * scratch merchant whose playbooks have generated ids. Without this, the
 * UNKNOWN_PLAYBOOK gate fires first and masks the failure the fixture is
 * actually meant to exercise.
 */
export function withPlaybookId(fixture: string, playbookId: string): string {
  const parsed = JSON.parse(fixture) as Record<string, unknown>;
  parsed.selectedPlaybookId = playbookId;
  return JSON.stringify(parsed);
}
