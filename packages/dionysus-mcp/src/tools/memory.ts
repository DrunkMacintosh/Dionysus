import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type ObservationInput = { title: string; body: string; sourceUrl: string; confidence: number };

/** D27.2 + §6.2: a radar-derived market observation is ALWAYS tainted and MUST carry a real source URL. */
export async function recordObservation(identity: Identity, input: ObservationInput): Promise<{ nodeId: string }> {
  if (!input.sourceUrl || !input.sourceUrl.trim()) {
    throw new Error("An observation requires a non-empty source URL (§6.2 — no unsourced sensing).");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Invalid confidence ${input.confidence} (must be a number in 0..1).`);
  }
  const row = await prisma.memoryNode.create({ data: {
    businessId: identity.businessId, type: "market-observation",
    title: input.title, body: input.body, confidence: input.confidence,
    sourceUrl: input.sourceUrl, tainted: true } });
  return { nodeId: row.id };
}

export type ObservationCard = { nodeId: string; title: string; body: string; sourceUrl: string | null; confidence: number; createdAt: Date };

export async function listObservations(identity: Identity, limit = 20): Promise<ObservationCard[]> {
  const rows = await prisma.memoryNode.findMany({
    where: { businessId: identity.businessId, type: "market-observation" },
    orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({ nodeId: r.id, title: r.title, body: r.body, sourceUrl: r.sourceUrl, confidence: r.confidence, createdAt: r.createdAt }));
}
