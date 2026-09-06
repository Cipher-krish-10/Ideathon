/**
 * Razorpay Test Mode smoke check.
 *
 *   PAYMENT_PROVIDER=razorpay npm run razorpay:smoke
 *
 * Creates ONE payment link against Razorpay Test Mode and prints the artifact.
 * Fails closed: without explicit test-mode configuration it refuses to run.
 * Never prints a credential.
 */
import fs from "node:fs";
import path from "node:path";

import { FakePaymentProvider, ProviderError, RazorpayProvider } from "../src/integrations/razorpay/index.js";
import type { PaymentProvider } from "../src/integrations/razorpay/index.js";

if (fs.existsSync(path.join(process.cwd(), ".env"))) {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

/** Show enough of a key to identify it, never enough to use it. */
const maskKey = (key: string) =>
  key.length <= 12 ? "***" : `${key.slice(0, 11)}…${key.slice(-4)}`;

async function main() {
  const mode = process.env.RAZORPAY_MODE;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const useReal = process.env.PAYMENT_PROVIDER === "razorpay";

  console.log("\nRAZORPAY TEST MODE SMOKE CHECK");
  console.log("=".repeat(70));
  console.log(`  PAYMENT_PROVIDER  ${process.env.PAYMENT_PROVIDER ?? "(unset — defaults to fake)"}`);
  console.log(`  RAZORPAY_MODE     ${mode ?? "(unset)"}`);
  console.log(`  RAZORPAY_KEY_ID   ${keyId ? maskKey(keyId) : "(unset)"}`);
  console.log(`  RAZORPAY_SECRET   ${keySecret ? "set (never printed)" : "(unset)"}`);
  console.log("");

  let provider: PaymentProvider;
  if (useReal) {
    try {
      // The adapter enforces the mode gate; this script does not second-guess it.
      provider = new RazorpayProvider({
        keyId: keyId ?? "", keySecret: keySecret ?? "", mode: mode ?? "",
      });
    } catch (error) {
      console.error(`REFUSED: ${(error as Error).message}`);
      console.error("\nSet RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_MODE=\"test\".");
      process.exitCode = 1;
      return;
    }
    console.log("  Using the REAL Razorpay adapter against Test Mode.\n");
  } else {
    provider = new FakePaymentProvider();
    console.log("  Using the FAKE provider — no external call will be made.");
    console.log('  Set PAYMENT_PROVIDER="razorpay" to exercise Razorpay Test Mode.\n');
  }

  // A stable reference, so re-running does not litter the account with links:
  // Razorpay rejects a duplicate reference_id, which is exactly the protection
  // the executor relies on.
  const referenceId = `rp_smoke_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;

  const existing = await provider.findPaymentLinkByReference(referenceId).catch(() => null);
  if (existing) {
    console.log("  A link already exists for today's reference — reusing it.\n");
    report(existing.providerEntityId, existing.shortUrl, existing.amountPaise, existing.status, referenceId);
    return;
  }

  try {
    const artifact = await provider.createPaymentLink({
      amountPaise: 100_000, // ₹1,000.00
      currency: "INR",
      description: "RevenuePilot smoke check — Razorpay Test Mode",
      referenceId,
      attributionRef: "rp_smoke",
      interventionId: "smoke",
      customerRef: "smoke_customer",
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    });
    report(artifact.providerEntityId, artifact.shortUrl, artifact.amountPaise, artifact.status, referenceId);
  } catch (error) {
    const providerError = error as ProviderError;
    console.error(`FAILED [${providerError.kind ?? "UNKNOWN"}]: ${providerError.message}`);
    process.exitCode = 1;
  }
}

function report(id: string, shortUrl: string, amountPaise: number, status: string, ref: string) {
  console.log("  ARTIFACT");
  console.log(`    payment link id   ${id}`);
  console.log(`    short url         ${shortUrl}`);
  console.log(`    amount            ${rupees(amountPaise)}`);
  console.log(`    reference         ${ref}`);
  console.log(`    status            ${status}`);
  console.log("");
  // Said plainly, because "created" is easy to misread as "paid".
  console.log('  "created" means the link exists. No payment has been made and no');
  console.log("  revenue has been recovered. Attribution is the next phase.");
}

main().catch((error) => {
  console.error("Smoke check crashed:", (error as Error).message);
  process.exitCode = 1;
});
