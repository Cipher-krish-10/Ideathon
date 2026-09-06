import { createHash } from "node:crypto";

import {
  ProviderError,
  type CreatePaymentLinkCommand,
  type PaymentLinkArtifact,
  type PaymentProvider,
  type ProviderErrorKind,
} from "./types";

/**
 * In-memory provider.
 *
 * Every test runs against this, and so does the offline demo. Behaves like the
 * real adapter at the interface level, including reference-id uniqueness and
 * reconciliation, so a test that passes here exercises the same executor paths.
 *
 * Artifact ids are derived from the reference, so they are deterministic: a
 * retry produces the same id, which is what makes duplicate-suppression
 * assertable.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";
  readonly mode = "test" as const;

  private readonly links = new Map<string, PaymentLinkArtifact>();
  /** Failures to inject, consumed in order. */
  private readonly failures: ProviderErrorKind[];
  private callIndex = 0;

  readonly commands: CreatePaymentLinkCommand[] = [];

  constructor(options: { failWith?: ProviderErrorKind[] } = {}) {
    this.failures = [...(options.failWith ?? [])];
  }

  get createCallCount(): number {
    return this.callIndex;
  }

  /** Pretend the provider created a link we never saw the response for. */
  seedOrphan(command: CreatePaymentLinkCommand): PaymentLinkArtifact {
    const artifact = this.buildArtifact(command, true);
    this.links.set(command.referenceId, artifact);
    return artifact;
  }

  async createPaymentLink(command: CreatePaymentLinkCommand): Promise<PaymentLinkArtifact> {
    this.commands.push(command);
    const failure = this.failures[this.callIndex];
    this.callIndex += 1;

    if (failure) {
      // An AMBIGUOUS failure records the link, exactly as a real timeout after
      // a successful write would: the action happened, the answer was lost.
      if (failure === "AMBIGUOUS" && !this.links.has(command.referenceId)) {
        this.links.set(command.referenceId, this.buildArtifact(command, true));
      }
      throw new ProviderError(`Injected ${failure} failure`, failure, failureStatus(failure));
    }

    const existing = this.links.get(command.referenceId);
    if (existing) {
      // Mirrors Razorpay's documented uniqueness on reference_id.
      throw new ProviderError(
        `A payment link already exists for reference ${command.referenceId}`,
        "VALIDATION",
        400,
      );
    }

    const artifact = this.buildArtifact(command, false);
    this.links.set(command.referenceId, artifact);
    return artifact;
  }

  async findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkArtifact | null> {
    const found = this.links.get(referenceId);
    return found ? { ...found, reconciled: true } : null;
  }

  private buildArtifact(
    command: CreatePaymentLinkCommand,
    reconciled: boolean,
  ): PaymentLinkArtifact {
    const suffix = createHash("sha256").update(command.referenceId).digest("hex").slice(0, 14);
    return {
      providerEntityId: `plink_FAKE${suffix}`,
      shortUrl: `https://rzp.io/i/fake${suffix.slice(0, 8)}`,
      amountPaise: command.amountPaise,
      currency: command.currency,
      // A created link is not a paid one. The fake must not pretend otherwise.
      status: "created",
      referenceId: command.referenceId,
      // Mirrors the shape of a real Razorpay response, so anything downstream
      // that reads `raw` (attribution, simulation) behaves identically.
      raw: {
        provider: "fake",
        id: `plink_FAKE${suffix}`,
        reference_id: command.referenceId,
        amount: command.amountPaise,
        status: "created",
        note: "No external call was made.",
      },
      reconciled,
    };
  }
}

function failureStatus(kind: ProviderErrorKind): number | undefined {
  switch (kind) {
    case "TRANSIENT": return 503;
    case "VALIDATION": return 400;
    case "AUTHENTICATION": return 401;
    default: return undefined;
  }
}
