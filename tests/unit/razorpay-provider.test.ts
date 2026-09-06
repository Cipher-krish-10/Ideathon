import { describe, expect, it, vi } from "vitest";

import { FakePaymentProvider, ProviderError, RazorpayProvider } from "@/integrations/razorpay";
import type { CreatePaymentLinkCommand } from "@/integrations/razorpay";

/** `fetch` is injected everywhere: no test reaches Razorpay or needs a key. */

const command: CreatePaymentLinkCommand = {
  amountPaise: 89_999_00, currency: "INR",
  description: "Complete your payment", referenceId: "rp_abc_001",
  attributionRef: "rp_abc", interventionId: "int_1", customerRef: "cust_0204",
  expiresAt: new Date("2026-09-13T00:00:00Z"),
};

const OK_LINK = {
  id: "plink_TEST123", short_url: "https://rzp.io/i/test123",
  amount: 89_999_00, currency: "INR", status: "created", reference_id: "rp_abc_001",
};

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

const provider = (fetchImpl: typeof fetch, overrides: Record<string, string> = {}) =>
  new RazorpayProvider({
    keyId: "rzp_test_abc123", keySecret: "secret_value", mode: "test",
    fetchImpl, ...overrides,
  });

describe("RazorpayProvider — test-mode enforcement", () => {
  it("refuses to construct without an explicit test mode", () => {
    // Razorpay documents no way to tell a test key from a live one, so the gate
    // is explicit configuration that fails closed.
    for (const mode of ["", "live", "production", "TEST"]) {
      expect(() => new RazorpayProvider({ keyId: "k", keySecret: "s", mode }))
        .toThrow(/must be explicitly "test"/);
    }
  });

  it("refuses to construct without both credentials", () => {
    expect(() => new RazorpayProvider({ keyId: "", keySecret: "s", mode: "test" }))
      .toThrow(/both required/);
    expect(() => new RazorpayProvider({ keyId: "k", keySecret: "", mode: "test" }))
      .toThrow(/both required/);
  });

  it("refuses a key that looks like a live key", () => {
    // An observed convention, used ONLY to refuse -- never to permit.
    expect(() => new RazorpayProvider({
      keyId: "rzp_live_abc", keySecret: "s", mode: "test",
    })).toThrow(/refuses to run against live mode/);
  });

  it("reports test mode and never anything else", () => {
    expect(provider(stubFetch(OK_LINK)).mode).toBe("test");
  });
});

describe("RazorpayProvider — create payment link", () => {
  it("sends exactly the documented fields", async () => {
    const fetchImpl = stubFetch(OK_LINK);
    await provider(fetchImpl).createPaymentLink(command);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/payment_links");

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    // amount is in paise, the smallest currency unit — a direct pass-through.
    expect(body.amount).toBe(89_999_00);
    expect(body.currency).toBe("INR");
    expect(body.reference_id).toBe("rp_abc_001");
    expect(body.expire_by).toBe(Math.floor(command.expiresAt.getTime() / 1000));
    // Razorpay must not contact anyone from a demo build.
    expect(body.notify).toEqual({ sms: false, email: false });
    expect(body.reminder_enable).toBe(false);
    expect((body.notes as Record<string, string>).attribution_ref).toBe("rp_abc");

    // The dataset holds only MASKED contact details, so no customer block is sent.
    expect(body).not.toHaveProperty("customer");
  });

  it("sends the credential as a Basic header and nowhere else", async () => {
    const fetchImpl = stubFetch(OK_LINK);
    await provider(fetchImpl).createPaymentLink(command);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    const expected = Buffer.from("rzp_test_abc123:secret_value").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expected}`);
    // Never in the body.
    expect((init as RequestInit).body as string).not.toContain("secret_value");
    expect((init as RequestInit).body as string).not.toContain("rzp_test_abc123");
  });

  it("maps the response into an artifact", async () => {
    const artifact = await provider(stubFetch(OK_LINK)).createPaymentLink(command);
    expect(artifact.providerEntityId).toBe("plink_TEST123");
    expect(artifact.shortUrl).toBe("https://rzp.io/i/test123");
    expect(artifact.amountPaise).toBe(89_999_00);
    // A created link is not a paid one.
    expect(artifact.status).toBe("created");
    expect(artifact.reconciled).toBe(false);
  });
});

describe("RazorpayProvider — failure classification", () => {
  it.each([
    [500, "TRANSIENT"], [503, "TRANSIENT"], [429, "TRANSIENT"],
    [400, "VALIDATION"], [404, "VALIDATION"],
    [401, "AUTHENTICATION"], [403, "AUTHENTICATION"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const fetchImpl = stubFetch({ error: { description: "boom" } }, status);
    await expect(provider(fetchImpl).createPaymentLink(command)).rejects.toMatchObject({ kind });
  });

  it("marks only transient and ambiguous failures retryable", () => {
    expect(new ProviderError("x", "TRANSIENT").isRetryable).toBe(true);
    expect(new ProviderError("x", "AMBIGUOUS").isRetryable).toBe(true);
    expect(new ProviderError("x", "VALIDATION").isRetryable).toBe(false);
    expect(new ProviderError("x", "AUTHENTICATION").isRetryable).toBe(false);
    expect(new ProviderError("x", "MALFORMED").isRetryable).toBe(false);
  });

  it("classifies a timeout as AMBIGUOUS, not transient", async () => {
    // The call may have succeeded. Retrying without reconciling first is how a
    // customer ends up with two payment links.
    const fetchImpl = vi.fn(async (_u: unknown, init: unknown) => {
      const signal = (init as RequestInit).signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      new RazorpayProvider({
        keyId: "rzp_test_a", keySecret: "s", mode: "test", timeoutMs: 10, fetchImpl,
      }).createPaymentLink(command),
    ).rejects.toMatchObject({ kind: "AMBIGUOUS" });
  });

  it("rejects a malformed response rather than persisting a half-understood link", async () => {
    for (const body of [
      { short_url: "https://x" },                       // no id
      { id: "plink_1", short_url: "https://x" },        // no amount
      { id: "plink_1", short_url: "https://x", amount: 1.5 }, // non-integer amount
    ]) {
      await expect(provider(stubFetch(body)).createPaymentLink(command))
        .rejects.toMatchObject({ kind: "MALFORMED" });
    }
  });

  it("rejects a response whose reference_id does not match", async () => {
    // Attributing a payment to the wrong intervention is worse than failing.
    const fetchImpl = stubFetch({ ...OK_LINK, reference_id: "someone_elses_ref" });
    await expect(provider(fetchImpl).createPaymentLink(command))
      .rejects.toThrow(/reference_id/);
  });
});

describe("RazorpayProvider — reconciliation", () => {
  it("queries the documented reference_id filter", async () => {
    const fetchImpl = stubFetch({ payment_links: [OK_LINK] });
    const found = await provider(fetchImpl).findPaymentLinkByReference("rp_abc_001");

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/payment_links?reference_id=rp_abc_001");
    expect(found?.providerEntityId).toBe("plink_TEST123");
    expect(found?.reconciled).toBe(true);
  });

  it("returns null when nothing matches", async () => {
    expect(await provider(stubFetch({ payment_links: [] }))
      .findPaymentLinkByReference("nope")).toBeNull();
  });
});

describe("FakePaymentProvider", () => {
  it("behaves like the real provider at the interface level", async () => {
    const fake = new FakePaymentProvider();
    const artifact = await fake.createPaymentLink(command);

    expect(artifact.providerEntityId).toMatch(/^plink_FAKE/);
    expect(artifact.amountPaise).toBe(command.amountPaise);
    expect(artifact.status).toBe("created");
    expect(fake.mode).toBe("test");
  });

  it("produces deterministic ids, so retries are assertable", async () => {
    const a = await new FakePaymentProvider().createPaymentLink(command);
    const b = await new FakePaymentProvider().createPaymentLink(command);
    expect(a.providerEntityId).toBe(b.providerEntityId);
  });

  it("enforces reference uniqueness like Razorpay does", async () => {
    const fake = new FakePaymentProvider();
    await fake.createPaymentLink(command);
    await expect(fake.createPaymentLink(command)).rejects.toMatchObject({ kind: "VALIDATION" });
  });

  it("records a link on an ambiguous failure, as a real lost response would", async () => {
    const fake = new FakePaymentProvider({ failWith: ["AMBIGUOUS"] });
    await expect(fake.createPaymentLink(command)).rejects.toMatchObject({ kind: "AMBIGUOUS" });
    // The action happened; only the answer was lost.
    expect(await fake.findPaymentLinkByReference(command.referenceId)).not.toBeNull();
  });
});
