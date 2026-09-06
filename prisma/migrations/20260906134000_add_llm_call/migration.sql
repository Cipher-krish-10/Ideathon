-- LlmCall: a record of every reasoning-model call, successful or not.
--
-- Failures are recorded as deliberately as successes. "The LLM is
-- non-authoritative" is only a demonstrable claim if the rejections are
-- visible, so a hallucinated figure or an unknown playbook produces a row
-- exactly like a valid answer does.
CREATE TYPE "LlmValidationOutcome" AS ENUM (
  'VALID',
  'EMPTY_RESPONSE',
  'MALFORMED_JSON',
  'SCHEMA_INVALID',
  'UNKNOWN_PLAYBOOK',
  'NUMERIC_HALLUCINATION',
  'UNSUPPORTED_MESSAGE_CLAIM',
  'CONFIDENCE_OVERCLAIM',
  'PROVIDER_ERROR'
);

CREATE TABLE "llm_call" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "interventionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "rawResponse" TEXT,
    "parsedOutput" JSONB,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "isValid" BOOLEAN NOT NULL,
    "validationOutcome" "LlmValidationOutcome" NOT NULL,
    "validationResult" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costPaise" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_call_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "llm_call_merchantId_createdAt_idx" ON "llm_call"("merchantId", "createdAt");
CREATE INDEX "llm_call_opportunityId_idx" ON "llm_call"("opportunityId");
CREATE INDEX "llm_call_interventionId_idx" ON "llm_call"("interventionId");

ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_interventionId_fkey"
  FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Latency and token counts are measurements, never negative.
ALTER TABLE "llm_call"
  ADD CONSTRAINT "llm_call_latency_non_negative" CHECK ("latencyMs" >= 0),
  ADD CONSTRAINT "llm_call_tokens_non_negative"
    CHECK (("inputTokens" IS NULL OR "inputTokens" >= 0)
       AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
       AND ("costPaise" IS NULL OR "costPaise" >= 0)),
  ADD CONSTRAINT "llm_call_attempt_no_positive" CHECK ("attemptNo" >= 1),
  -- isValid and validationOutcome must agree: VALID iff isValid.
  ADD CONSTRAINT "llm_call_validity_matches_outcome"
    CHECK (("isValid" = true AND "validationOutcome" = 'VALID')
        OR ("isValid" = false AND "validationOutcome" <> 'VALID'));
