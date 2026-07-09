import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type CaseInput = {
  name: string; platform: string; mode: string; rank: number;
  historicalArc: unknown; modernizedPlan: unknown; insight: string;
  sources: unknown; confidence: number;
};

export async function persistCase(identity: Identity, input: CaseInput): Promise<{ caseId: string }> {
  const row = await prisma.case.create({ data: {
    businessId: identity.businessId,
    name: input.name, platform: input.platform, mode: input.mode, rank: input.rank,
    historicalArcJson: JSON.stringify(input.historicalArc),
    modernizedPlanJson: JSON.stringify(input.modernizedPlan),
    insight: input.insight,
    sourcesJson: JSON.stringify(input.sources),
    confidence: input.confidence,
  }});
  return { caseId: row.id };
}
