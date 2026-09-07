import "server-only";

import type { GuardrailPolicyRules } from "@/core/guardrails";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import { getSessionProjection } from "@/server/services/simulation/session-time";

/**
 * Guardrail policy reads and edits.
 *
 * Lives in a service rather than a route handler so the versioning rule — a
 * policy is never mutated in place — is enforced in one testable place, not
 * duplicated between the API and the page that renders it.
 */

export interface PolicySnapshot {
  activeVersion: number;
  rules: Record<string, Record<string, unknown>>;
  versions: { version: number; isActive: boolean; createdAt: string }[];
}

export async function getPolicySnapshot(merchantId: string): Promise<PolicySnapshot | null> {
  const [policies, clock] = await Promise.all([
    prisma.guardrailPolicy.findMany({
      where: { merchantId }, orderBy: { version: "desc" },
    }),
    // Displayed on the simulation clock, like every other timestamp shown.
    getSessionProjection(merchantId),
  ]);
  const active = policies.find((policy) => policy.isActive) ?? policies[0];
  if (!active) return null;

  return {
    activeVersion: active.version,
    rules: active.rules as Record<string, Record<string, unknown>>,
    versions: policies.map((policy) => ({
      version: policy.version,
      isActive: policy.isActive,
      createdAt: clock.project(policy.createdAt).toISOString(),
    })),
  };
}

/**
 * Save a new policy version.
 *
 * Creates a version and deactivates the previous one. Never an in-place update:
 * a GuardrailEvaluation records the version it ran under, and that reference
 * has to keep meaning what it meant at the time.
 */
export async function savePolicyVersion(
  merchantId: string,
  userId: string,
  rules: GuardrailPolicyRules,
): Promise<{ activeVersion: number; rules: unknown }> {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.guardrailPolicy.findFirst({
      where: { merchantId }, orderBy: { version: "desc" },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    await tx.guardrailPolicy.updateMany({
      where: { merchantId, isActive: true }, data: { isActive: false },
    });

    const policy = await tx.guardrailPolicy.create({
      data: { merchantId, version: nextVersion, rules, isActive: true, updatedById: userId },
    });

    await appendAuditEntry(tx, {
      merchantId, actorType: "USER", actorId: userId,
      entityType: "GuardrailPolicy", entityId: policy.id,
      action: "POLICY_VERSION_CREATED",
      before: latest ? { version: latest.version, rules: latest.rules } : null,
      after: { version: nextVersion, rules },
    });

    return { activeVersion: policy.version, rules: policy.rules };
  });
}
