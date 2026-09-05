-- CreateEnum
CREATE TYPE "MerchantMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('VIEWER', 'APPROVER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CustomerTier" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "CustomerTierScope" AS ENUM ('ALL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('CUSTOMER_OPT_OUT', 'CHARGEBACK_DISPUTE', 'SUPPORT_ESCALATION');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('SUBSCRIPTION', 'ADDON', 'SERVICE', 'COURSE', 'MERCH', 'HARDWARE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'UPI', 'NETBANKING', 'WALLET');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('INSUFFICIENT_FUNDS', 'PAYMENT_NETWORK_ERROR', 'AUTHENTICATION_FAILED', 'PAYMENT_METHOD_DECLINED', 'EXPIRED_CARD', 'SUSPECTED_FRAUD', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('FAILED_PAYMENT_RECOVERY');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'PLANNED', 'DISMISSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlaybookActionType" AS ENUM ('REMINDER_ONLY', 'PAYMENT_LINK_PLAIN', 'PAYMENT_LINK_WITH_OFFER');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "InterventionState" AS ENUM ('DRAFT', 'PROPOSED', 'GUARDRAIL_BLOCKED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTING', 'EXECUTED', 'EXECUTION_FAILED', 'OBSERVING', 'CONVERTED', 'NOT_CONVERTED', 'LEARNED');

-- CreateEnum
CREATE TYPE "ReasoningMode" AS ENUM ('LLM', 'DETERMINISTIC_FALLBACK');

-- CreateEnum
CREATE TYPE "GuardrailPhase" AS ENUM ('PRE_APPROVAL', 'PRE_EXECUTION');

-- CreateEnum
CREATE TYPE "GuardrailDecision" AS ENUM ('PASS', 'WARN', 'REQUIRE_APPROVAL', 'BLOCK');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('PAYMENT_LINK', 'OFFER');

-- CreateEnum
CREATE TYPE "AttributionMethod" AS ENUM ('DIRECT_REF', 'WINDOW_MATCH', 'MANUAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'AGENT', 'USER', 'WEBHOOK');

-- CreateTable
CREATE TABLE "merchant" (
    "id" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "mode" "MerchantMode" NOT NULL DEFAULT 'TEST',
    "datasetReferenceAt" TIMESTAMP(3) NOT NULL,
    "datasetSeed" INTEGER NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "maskedEmail" TEXT NOT NULL,
    "maskedPhone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "signupAt" TIMESTAMP(3) NOT NULL,
    "historicalValuePaise" INTEGER NOT NULL,
    "lifetimeValuePaise" INTEGER NOT NULL,
    "tier" "CustomerTier" NOT NULL,
    "doNotContactUntil" TIMESTAMP(3),
    "suppressionReason" "SuppressionReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "TransactionStatus" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "attemptCount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempt" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "AttemptStatus" NOT NULL,
    "failureReason" "FailureReason",
    "method" "PaymentMethod" NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "retryOfAttemptId" TEXT,
    "gatewayRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" "OpportunityType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "detectorKey" TEXT NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "affectedCustomerCount" INTEGER NOT NULL,
    "recoverableAmountPaise" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "referenceAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_target" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "recoverableAmountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actionType" "PlaybookActionType" NOT NULL,
    "defaultDiscountBps" INTEGER NOT NULL DEFAULT 0,
    "channelCostPaise" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "expectedGrossPaise" INTEGER NOT NULL,
    "discountCostPaise" INTEGER NOT NULL,
    "channelCostPaise" INTEGER NOT NULL,
    "gatewayFeePaise" INTEGER NOT NULL,
    "costPaise" INTEGER NOT NULL,
    "expectedNetPaise" INTEGER NOT NULL,
    "pRecoverAvgBps" INTEGER NOT NULL,
    "confidence" "ConfidenceLevel" NOT NULL,
    "inputsSnapshot" JSONB NOT NULL,
    "estimatorVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "state" "InterventionState" NOT NULL DEFAULT 'DRAFT',
    "reasoningMode" "ReasoningMode" NOT NULL DEFAULT 'DETERMINISTIC_FALLBACK',
    "rationale" TEXT,
    "customerMessage" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "attributionRef" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "proposedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention_target" (
    "id" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "perTargetRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intervention_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_policy" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_evaluation" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "phase" "GuardrailPhase" NOT NULL,
    "decision" "GuardrailDecision" NOT NULL,
    "ruleResults" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "note" TEXT,
    "editedMessage" JSONB,
    "interventionVersion" INTEGER NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_attempt" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "targetId" TEXT,
    "attemptNo" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "request" JSONB,
    "responseStatus" INTEGER,
    "response" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "execution_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "razorpay_artifact" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "executionAttemptId" TEXT,
    "artifactType" "ArtifactType" NOT NULL,
    "providerEntityId" TEXT NOT NULL,
    "shortUrl" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "razorpay_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "rawBody" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_record" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "paymentAttemptId" TEXT,
    "webhookEventId" TEXT,
    "method" "AttributionMethod" NOT NULL,
    "confidence" "ConfidenceLevel" NOT NULL,
    "attributedAmountPaise" INTEGER NOT NULL,
    "note" TEXT,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attribution_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_stat" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "failureReason" "FailureReason" NOT NULL,
    "tierScope" "CustomerTierScope" NOT NULL DEFAULT 'ALL',
    "alphaMilli" INTEGER NOT NULL,
    "betaMilli" INTEGER NOT NULL,
    "seededAlphaMilli" INTEGER NOT NULL,
    "seededBetaMilli" INTEGER NOT NULL,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "playbook_stat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_sourceRef_key" ON "merchant"("sourceRef");

-- CreateIndex
CREATE INDEX "user_merchantId_role_idx" ON "user"("merchantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "user_merchantId_email_key" ON "user"("merchantId", "email");

-- CreateIndex
CREATE INDEX "customer_merchantId_tier_idx" ON "customer"("merchantId", "tier");

-- CreateIndex
CREATE INDEX "customer_merchantId_lifetimeValuePaise_idx" ON "customer"("merchantId", "lifetimeValuePaise");

-- CreateIndex
CREATE INDEX "customer_merchantId_doNotContactUntil_idx" ON "customer"("merchantId", "doNotContactUntil");

-- CreateIndex
CREATE UNIQUE INDEX "customer_merchantId_sourceRef_key" ON "customer"("merchantId", "sourceRef");

-- CreateIndex
CREATE INDEX "product_merchantId_category_idx" ON "product"("merchantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "product_merchantId_sourceRef_key" ON "product"("merchantId", "sourceRef");

-- CreateIndex
CREATE INDEX "transaction_merchantId_status_idx" ON "transaction"("merchantId", "status");

-- CreateIndex
CREATE INDEX "transaction_merchantId_customerId_idx" ON "transaction"("merchantId", "customerId");

-- CreateIndex
CREATE INDEX "transaction_merchantId_occurredAt_idx" ON "transaction"("merchantId", "occurredAt");

-- CreateIndex
CREATE INDEX "transaction_merchantId_status_occurredAt_idx" ON "transaction"("merchantId", "status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_merchantId_sourceRef_key" ON "transaction"("merchantId", "sourceRef");

-- CreateIndex
CREATE INDEX "payment_attempt_merchantId_status_idx" ON "payment_attempt"("merchantId", "status");

-- CreateIndex
CREATE INDEX "payment_attempt_merchantId_failureReason_idx" ON "payment_attempt"("merchantId", "failureReason");

-- CreateIndex
CREATE INDEX "payment_attempt_transactionId_idx" ON "payment_attempt"("transactionId");

-- CreateIndex
CREATE INDEX "payment_attempt_merchantId_status_occurredAt_idx" ON "payment_attempt"("merchantId", "status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_merchantId_sourceRef_key" ON "payment_attempt"("merchantId", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_transactionId_attemptNo_key" ON "payment_attempt"("transactionId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_retryOfAttemptId_key" ON "payment_attempt"("retryOfAttemptId");

-- CreateIndex
CREATE INDEX "opportunity_merchantId_status_idx" ON "opportunity"("merchantId", "status");

-- CreateIndex
CREATE INDEX "opportunity_merchantId_type_detectedAt_idx" ON "opportunity"("merchantId", "type", "detectedAt");

-- CreateIndex
CREATE INDEX "opportunity_target_opportunityId_idx" ON "opportunity_target"("opportunityId");

-- CreateIndex
CREATE INDEX "opportunity_target_customerId_idx" ON "opportunity_target"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_target_opportunityId_transactionId_key" ON "opportunity_target"("opportunityId", "transactionId");

-- CreateIndex
CREATE INDEX "playbook_merchantId_isActive_idx" ON "playbook"("merchantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_merchantId_key_key" ON "playbook"("merchantId", "key");

-- CreateIndex
CREATE INDEX "estimate_merchantId_idx" ON "estimate"("merchantId");

-- CreateIndex
CREATE INDEX "estimate_opportunityId_idx" ON "estimate"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_opportunityId_playbookId_key" ON "estimate"("opportunityId", "playbookId");

-- CreateIndex
CREATE UNIQUE INDEX "intervention_attributionRef_key" ON "intervention"("attributionRef");

-- CreateIndex
CREATE INDEX "intervention_merchantId_state_idx" ON "intervention"("merchantId", "state");

-- CreateIndex
CREATE INDEX "intervention_merchantId_createdAt_idx" ON "intervention"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "intervention_opportunityId_idx" ON "intervention"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "intervention_target_perTargetRef_key" ON "intervention_target"("perTargetRef");

-- CreateIndex
CREATE INDEX "intervention_target_interventionId_idx" ON "intervention_target"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "intervention_target_interventionId_transactionId_key" ON "intervention_target"("interventionId", "transactionId");

-- CreateIndex
CREATE INDEX "guardrail_policy_merchantId_isActive_idx" ON "guardrail_policy"("merchantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "guardrail_policy_merchantId_version_key" ON "guardrail_policy"("merchantId", "version");

-- CreateIndex
CREATE INDEX "guardrail_evaluation_interventionId_phase_idx" ON "guardrail_evaluation"("interventionId", "phase");

-- CreateIndex
CREATE INDEX "guardrail_evaluation_merchantId_evaluatedAt_idx" ON "guardrail_evaluation"("merchantId", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "approval_interventionId_key" ON "approval"("interventionId");

-- CreateIndex
CREATE INDEX "approval_merchantId_decidedAt_idx" ON "approval"("merchantId", "decidedAt");

-- CreateIndex
CREATE INDEX "approval_userId_idx" ON "approval"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "execution_attempt_idempotencyKey_key" ON "execution_attempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "execution_attempt_merchantId_status_idx" ON "execution_attempt"("merchantId", "status");

-- CreateIndex
CREATE INDEX "execution_attempt_interventionId_idx" ON "execution_attempt"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "execution_attempt_interventionId_attemptNo_key" ON "execution_attempt"("interventionId", "attemptNo");

-- CreateIndex
CREATE INDEX "razorpay_artifact_interventionId_idx" ON "razorpay_artifact"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "razorpay_artifact_merchantId_providerEntityId_key" ON "razorpay_artifact"("merchantId", "providerEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_providerEventId_key" ON "webhook_event"("providerEventId");

-- CreateIndex
CREATE INDEX "webhook_event_merchantId_eventType_idx" ON "webhook_event"("merchantId", "eventType");

-- CreateIndex
CREATE INDEX "webhook_event_processedAt_idx" ON "webhook_event"("processedAt");

-- CreateIndex
CREATE INDEX "attribution_record_merchantId_attributedAt_idx" ON "attribution_record"("merchantId", "attributedAt");

-- CreateIndex
CREATE INDEX "attribution_record_interventionId_idx" ON "attribution_record"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "attribution_record_interventionId_transactionId_key" ON "attribution_record"("interventionId", "transactionId");

-- CreateIndex
CREATE INDEX "playbook_stat_merchantId_idx" ON "playbook_stat"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "playbook_stat_merchantId_playbookId_failureReason_tierScope_key" ON "playbook_stat"("merchantId", "playbookId", "failureReason", "tierScope");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_hash_key" ON "audit_log"("hash");

-- CreateIndex
CREATE INDEX "audit_log_merchantId_entityType_entityId_idx" ON "audit_log"("merchantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_merchantId_createdAt_idx" ON "audit_log"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_merchantId_seq_key" ON "audit_log"("merchantId", "seq");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_retryOfAttemptId_fkey" FOREIGN KEY ("retryOfAttemptId") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_target" ADD CONSTRAINT "opportunity_target_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_target" ADD CONSTRAINT "opportunity_target_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_target" ADD CONSTRAINT "opportunity_target_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_target" ADD CONSTRAINT "opportunity_target_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook" ADD CONSTRAINT "playbook_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate" ADD CONSTRAINT "estimate_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate" ADD CONSTRAINT "estimate_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate" ADD CONSTRAINT "estimate_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "playbook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "playbook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_target" ADD CONSTRAINT "intervention_target_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_target" ADD CONSTRAINT "intervention_target_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intervention_target" ADD CONSTRAINT "intervention_target_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_policy" ADD CONSTRAINT "guardrail_policy_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_policy" ADD CONSTRAINT "guardrail_policy_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_evaluation" ADD CONSTRAINT "guardrail_evaluation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_evaluation" ADD CONSTRAINT "guardrail_evaluation_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_evaluation" ADD CONSTRAINT "guardrail_evaluation_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "guardrail_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempt" ADD CONSTRAINT "execution_attempt_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempt" ADD CONSTRAINT "execution_attempt_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempt" ADD CONSTRAINT "execution_attempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "intervention_target"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_artifact" ADD CONSTRAINT "razorpay_artifact_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_artifact" ADD CONSTRAINT "razorpay_artifact_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razorpay_artifact" ADD CONSTRAINT "razorpay_artifact_executionAttemptId_fkey" FOREIGN KEY ("executionAttemptId") REFERENCES "execution_attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_record" ADD CONSTRAINT "attribution_record_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_record" ADD CONSTRAINT "attribution_record_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_record" ADD CONSTRAINT "attribution_record_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_record" ADD CONSTRAINT "attribution_record_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribution_record" ADD CONSTRAINT "attribution_record_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "webhook_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_stat" ADD CONSTRAINT "playbook_stat_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_stat" ADD CONSTRAINT "playbook_stat_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "playbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
