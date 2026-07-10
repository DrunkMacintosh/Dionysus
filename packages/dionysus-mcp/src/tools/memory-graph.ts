import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export const MEMORY_NODE_TYPES = ["waypoint", "action", "outcome", "learning", "market-observation", "case", "revision"] as const;
export const MEMORY_EDGE_KINDS = ["next", "caused", "informed-by", "supersedes", "references"] as const;
export type MemoryNodeType = (typeof MEMORY_NODE_TYPES)[number];
export type MemoryEdgeKind = (typeof MEMORY_EDGE_KINDS)[number];

export type MemoryNodeInput = { type: MemoryNodeType; title: string; body: string; confidence: number; role?: string; waypointId?: string; sourceId?: string; tainted?: boolean };
export type MemoryEdgeInput = { fromId: string; toId: string; kind: MemoryEdgeKind };

/** §13: a plan-mirror or memory node. Mirror nodes reflect our own server-set structured plan, so tainted defaults FALSE (recordObservation is the only writer that forces true). */
export async function persistMemoryNode(identity: Identity, input: MemoryNodeInput): Promise<{ nodeId: string }> {
  if (!MEMORY_NODE_TYPES.includes(input.type)) throw new Error(`Invalid memory node type "${input.type}".`);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Invalid confidence ${input.confidence} (must be a number in 0..1).`);
  }
  const row = await prisma.memoryNode.create({ data: {
    businessId: identity.businessId, type: input.type, title: input.title, body: input.body,
    confidence: input.confidence, role: input.role ?? null, waypointId: input.waypointId ?? null,
    sourceId: input.sourceId ?? null, tainted: input.tainted ?? false } });
  return { nodeId: row.id };
}

/** §10: an idempotent graph edge. Both endpoints must belong to the caller's business (findFirst scope guard); dedups on (businessId, fromId, toId, kind). */
export async function persistMemoryEdge(identity: Identity, input: MemoryEdgeInput): Promise<{ edgeId: string }> {
  if (!MEMORY_EDGE_KINDS.includes(input.kind)) throw new Error(`Invalid memory edge kind "${input.kind}".`);
  const from = await prisma.memoryNode.findFirst({ where: { id: input.fromId, businessId: identity.businessId } });
  if (!from) throw new Error(`Edge fromId ${input.fromId} not found in this business scope.`);
  const to = await prisma.memoryNode.findFirst({ where: { id: input.toId, businessId: identity.businessId } });
  if (!to) throw new Error(`Edge toId ${input.toId} not found in this business scope.`);
  const existing = await prisma.memoryEdge.findFirst({
    where: { businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind } });
  if (existing) return { edgeId: existing.id };
  const row = await prisma.memoryEdge.create({ data: {
    businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind } });
  return { edgeId: row.id };
}
