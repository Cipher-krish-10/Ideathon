import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * The live activity feed.
 *
 * DERIVED ENTIRELY from the append-only audit log. There is no parallel event
 * store, and nothing is invented for visual effect: if a line appears in the
 * feed, an audited operation produced it. That is the whole point — a timeline
 * that can show events which did not happen is worse than no timeline.
 *
 * The audit log already records actor, entity, action and payload, so this is a
 * presentation mapping and nothing more.
 */

export type ActivityPhase =
  | "OBSERVE" | "REASON" | "GUARDRAIL" | "APPROVAL"
  | "EXECUTE" | "PAYMENT" | "ATTRIBUTION" | "LEARN" | "POLICY";

export interface ActivityEntry {
  seq: number;
  at: string;
  phase: ActivityPhase;
  /** What a person would say happened. */
  label: string;
  /** Real figures pulled from the audited payload, when the event carried any. */
  detail: string | null;
  actorType: string;
  /** True when this event was produced by the demo simulator. */
  simulated: boolean;
  tone: "neutral" | "good" | "bad";
}

interface Mapping {
  phase: ActivityPhase;
  label: string;
  tone?: "neutral" | "good" | "bad";
  detail?: (after: Record<string, unknown>) => string | null;
}

const rupees = (paise: unknown): string =>
  typeof paise === "number"
    ? `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
    : "—";

/**
 * Audit action → timeline line.
 *
 * An unmapped action is skipped rather than rendered raw: the feed is for a
 * merchant, not a log tail.
 */
const MAPPINGS: Record<string, Mapping> = {
  OPPORTUNITY_DETECTED: {
    phase: "OBSERVE", label: "Recovery opportunities detected",
    detail: (after) =>
      `${after.qualifyingCount ?? "—"} customers · ${rupees(after.recoverableAmountPaise)} at risk`,
  },
  REASONING_REQUESTED: {
    phase: "REASON", label: "Agent started analysis",
    detail: (after) => `${after.candidateCount ?? "—"} scored strategies · ${after.model ?? "—"}`,
  },
  LLM_RESPONSE_ACCEPTED: {
    phase: "REASON", label: "AI recommendation validated", tone: "good",
    detail: (after) => `attempt ${after.attemptNo ?? 1} · ${after.latencyMs ?? "?"}ms`,
  },
  LLM_RESPONSE_REJECTED: {
    phase: "REASON", label: "AI response rejected by validation", tone: "bad",
    detail: (after) => String(after.outcome ?? "invalid"),
  },
  INTERVENTION_PROPOSED: {
    phase: "REASON", label: "AI recommended a recovery strategy",
    detail: (after) =>
      `${after.playbookKey ?? "—"} · expected net ${rupees(after.expectedNetPaise)}`,
  },
  PROPOSAL_SUBMITTED_FOR_APPROVAL: {
    phase: "GUARDRAIL", label: "Guardrails evaluated (pre-approval)",
    detail: (after) => `decision ${after.decision ?? "—"} · policy v${after.policyVersion ?? "?"}`,
  },
  PROPOSAL_BLOCKED_BY_GUARDRAIL: {
    phase: "GUARDRAIL", label: "Proposal blocked by guardrails", tone: "bad",
    detail: (after) => (Array.isArray(after.failedRules) ? after.failedRules.join(", ") : null),
  },
  APPROVAL_RECORDED: {
    phase: "APPROVAL", label: "Merchant decision recorded",
    detail: (after) => `${after.decision ?? "—"}${after.messageEdited ? " · message edited" : ""}`,
  },
  INTERVENTION_APPROVED: {
    phase: "APPROVAL", label: "Merchant approved the intervention", tone: "good",
    detail: (after) => `guardrails ${after.guardrailDecision ?? "—"}`,
  },
  INTERVENTION_REJECTED: {
    phase: "APPROVAL", label: "Merchant rejected the intervention", tone: "bad",
    detail: (after) => (typeof after.reason === "string" ? after.reason : null),
  },
  APPROVAL_BLOCKED_BY_GUARDRAIL: {
    phase: "GUARDRAIL", label: "Approval blocked by guardrails", tone: "bad",
    detail: (after) =>
      Array.isArray(after.blockingRules)
        ? (after.blockingRules as { ruleId?: string }[]).map((r) => r.ruleId).join(", ")
        : null,
  },
  EXECUTION_BLOCKED_BY_GUARDRAIL: {
    phase: "GUARDRAIL", label: "Execution blocked by guardrails", tone: "bad",
    detail: (after) => (Array.isArray(after.blockingRules) ? after.blockingRules.join(", ") : null),
  },
  EXECUTION_REQUESTED: {
    phase: "EXECUTE", label: "Execution requested",
    detail: (after) => `${after.provider ?? "—"} · ${after.targetCount ?? "?"} targets`,
  },
  ARTIFACTS_CREATED: {
    phase: "EXECUTE", label: "Razorpay Test Mode payment links created", tone: "good",
    detail: (after) => `${after.count ?? "—"} links · ${rupees(after.totalAmountPaise)}`,
  },
  EXECUTION_SUCCEEDED: {
    phase: "EXECUTE", label: "Execution completed",
    // Said plainly, because "executed" is easy to misread as "paid".
    detail: () => "action created at the provider — not yet revenue",
  },
  EXECUTION_FAILED: {
    phase: "EXECUTE", label: "Execution failed", tone: "bad",
    detail: (after) => (Array.isArray(after.kinds) ? after.kinds.join(", ") : null),
  },
  OBSERVING_STARTED: {
    phase: "EXECUTE", label: "Awaiting payment",
    detail: (after) => `${after.artifactCount ?? "—"} links live`,
  },
  WEBHOOK_RECEIVED: {
    phase: "PAYMENT", label: "Payment webhook received and verified", tone: "good",
    detail: (after) => String(after.eventType ?? "—"),
  },
  WEBHOOK_SIGNATURE_REJECTED: {
    phase: "PAYMENT", label: "Webhook rejected — signature invalid", tone: "bad",
    detail: () => "not processed",
  },
  WEBHOOK_DUPLICATE_IGNORED: {
    phase: "PAYMENT", label: "Duplicate webhook ignored",
    detail: () => "nothing double-counted",
  },
  TRANSACTION_RECOVERED: {
    phase: "PAYMENT", label: "Payment succeeded", tone: "good",
    detail: (after) => rupees(after.amountPaise),
  },
  ATTRIBUTION_SUCCEEDED: {
    phase: "ATTRIBUTION", label: "Attribution confirmed", tone: "good",
    detail: (after) =>
      `${after.method ?? "—"} · ${after.confidence ?? "—"} · ${rupees(after.attributedAmountPaise)}`,
  },
  ATTRIBUTION_UNRESOLVED: {
    phase: "ATTRIBUTION", label: "Attribution refused — evidence insufficient", tone: "bad",
    detail: (after) => String(after.reason ?? "unresolved"),
  },
  INTERVENTION_CONVERTED: {
    phase: "ATTRIBUTION", label: "Revenue recovered", tone: "good",
    detail: (after) => `${rupees(after.attributedAmountPaise)} attributed`,
  },
  INTERVENTION_NOT_CONVERTED: {
    phase: "ATTRIBUTION", label: "Attribution window closed with no payment",
    detail: () => "counted as a non-conversion",
  },
  PLAYBOOK_STAT_INCREMENTED: {
    phase: "LEARN", label: "Playbook learning updated", tone: "good",
    detail: (after) => `${after.playbookKey ?? "—"} · ${after.outcome ?? "—"} · ${after.failureReason ?? "—"}`,
  },
  POLICY_VERSION_CREATED: {
    phase: "POLICY", label: "Guardrail policy updated",
    detail: (after) => `now version ${after.version ?? "?"}`,
  },
  INTERVENTION_EXPIRED: { phase: "APPROVAL", label: "Proposal expired", tone: "bad" },
  INTERVENTION_CANCELLED: { phase: "APPROVAL", label: "Intervention cancelled", tone: "bad" },
};

/**
 * Build the feed from audit entries.
 *
 * Newest last, so it reads like a session transcript.
 */
export async function getActivityFeed(
  merchantId: string,
  options: { limit?: number; client?: PrismaClient } = {},
): Promise<ActivityEntry[]> {
  const db = options.client ?? prisma;

  const entries = await db.auditLog.findMany({
    where: { merchantId },
    orderBy: { seq: "desc" },
    take: options.limit ?? 60,
  });

  // Which webhook events came from the demo simulator, so the feed can say so.
  const simulatedEventIds = new Set(
    (await db.webhookEvent.findMany({
      where: { merchantId },
      select: { id: true, headers: true },
    }))
      .filter((event) =>
        (event.headers as Record<string, string> | null)?.["x-revenuepilot-simulated"] === "true")
      .map((event) => event.id),
  );

  const feed: ActivityEntry[] = [];
  for (const entry of entries) {
    const mapping = MAPPINGS[entry.action];
    // Unmapped actions are skipped: the feed is for a merchant, not a log tail.
    if (!mapping) continue;

    const after = (entry.after ?? {}) as Record<string, unknown>;
    feed.push({
      seq: Number(entry.seq),
      at: entry.createdAt.toISOString(),
      phase: mapping.phase,
      label: mapping.label,
      detail: mapping.detail?.(after) ?? null,
      actorType: entry.actorType,
      simulated:
        entry.entityType === "WebhookEvent" && simulatedEventIds.has(entry.entityId),
      tone: mapping.tone ?? "neutral",
    });
  }

  return feed.reverse();
}
