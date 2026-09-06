import { notFound } from "next/navigation";

import { DecisionPacket } from "@/components/decision-packet";
import type { DecisionPacketData } from "@/components/decision-packet";
import { requireSession } from "@/server/auth/session";
import { getDecisionPacket } from "@/server/services/read.service";
import { expireIfLapsed } from "@/server/services/intervention-state.service";

export const dynamic = "force-dynamic";

export default async function InterventionPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  const { id } = await params;

  // Request-time expiry: a lapsed proposal must not render as approvable.
  await expireIfLapsed(id).catch(() => null);

  const packet = await getDecisionPacket(session.merchantId, id);
  if (!packet) notFound();

  return <DecisionPacket packet={packet as unknown as DecisionPacketData} />;
}
