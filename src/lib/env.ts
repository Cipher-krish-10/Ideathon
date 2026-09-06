import "server-only";

import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Import this instead of reading `process.env` directly. Anything missing or
 * malformed fails loudly at startup rather than as a confusing runtime error
 * three layers deep.
 *
 * `server-only` makes it a build error to import this from a client component,
 * so no environment value can be bundled into the browser payload.
 *
 * Razorpay and LLM credentials are deliberately absent — they arrive in the
 * phases that actually need them, and only inside their own adapter modules.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string",
    ),

  /**
   * Gates seeding, resets, and the demo simulation endpoints. These must never
   * be reachable outside the hackathon demo environment, so the default is off.
   */
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Reasoning-model credential. OPTIONAL by design: with no key the reasoner
   * falls back deterministically and says so, rather than failing. Read only
   * inside src/integrations/llm, never logged, never placed in a prompt.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5"),

  /**
   * Groq alternative. Groq serves open models behind an OpenAI-compatible API.
   * Model ids change, so GROQ_MODEL is configurable; confirm against Groq's
   * current model list if a call reports an unknown model.
   */
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),

  /**
   * Which provider to use. "auto" prefers Anthropic, then Groq, then falls back
   * deterministically — so adding a key is the only step needed to switch on
   * real reasoning.
   */
  LLM_PROVIDER: z.enum(["auto", "anthropic", "groq", "none"]).default("auto"),

  /**
   * Payment execution. Defaults to the FAKE provider: enabling real calls has
   * to be a deliberate act, never something that happens because a variable
   * was left unset.
   */
  PAYMENT_PROVIDER: z.enum(["fake", "razorpay"]).default("fake"),

  /**
   * Razorpay credentials. Read ONLY inside src/integrations/razorpay.
   *
   * RAZORPAY_MODE has NO DEFAULT and must be the literal "test". Razorpay does
   * not document a way to tell a test key from a live one, so the mode gate is
   * explicit configuration that fails closed rather than a guess at a prefix.
   */
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_MODE: z.literal("test").optional(),
})
  .refine(
    (env) =>
      env.PAYMENT_PROVIDER !== "razorpay" ||
      (Boolean(env.RAZORPAY_KEY_ID) && Boolean(env.RAZORPAY_KEY_SECRET) &&
       env.RAZORPAY_MODE === "test"),
    {
      message:
        'PAYMENT_PROVIDER="razorpay" requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, ' +
        'and RAZORPAY_MODE="test". Refusing to start without all three.',
      path: ["PAYMENT_PROVIDER"],
    },
  );

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

let cached: Env | undefined;

/** Validated environment. Parsed once, then memoised. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only hook so a suite can assert on validation failures. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
