import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

/** True for a Prisma unique-constraint violation (P2002) — the concurrent-writer race we re-find on. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

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
  const dedupWhere = { businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind };
  const existing = await prisma.memoryEdge.findFirst({ where: dedupWhere });
  if (existing) return { edgeId: existing.id };
  try {
    const row = await prisma.memoryEdge.create({ data: dedupWhere });
    return { edgeId: row.id };
  } catch (error: unknown) {
    // Concurrency: a racing writer inserted the same (businessId, fromId, toId, kind) first — re-find it.
    if (isUniqueViolation(error)) {
      const row = await prisma.memoryEdge.findFirst({ where: dedupWhere });
      if (row) return { edgeId: row.id };
    }
    throw error;
  }
}

/** Find-or-create a mirror node keyed by (businessId, type, sourceId) — the idempotency primitive for the plan mirror. */
async function findOrCreateMirrorNode(identity: Identity, input: MemoryNodeInput & { sourceId: string }): Promise<string> {
  const dedupWhere = { businessId: identity.businessId, type: input.type, sourceId: input.sourceId };
  const existing = await prisma.memoryNode.findFirst({ where: dedupWhere });
  if (existing) return existing.id;
  try {
    const { nodeId } = await persistMemoryNode(identity, input);
    return nodeId;
  } catch (error: unknown) {
    // Concurrency: a racing mirror inserted the same (businessId, type, sourceId) first — re-find it.
    if (isUniqueViolation(error)) {
      const row = await prisma.memoryNode.findFirst({ where: dedupWhere });
      if (row) return row.id;
    }
    throw error;
  }
}

/**
 * §13 anchored-to-the-plan: mirror the STRUCTURED plan into the evolution graph — one `waypoint`
 * node per RouteWaypoint and one `action` node per RouteAction, wired by a `next` spine along the
 * ordered waypoints and `references` edges from each action node to its waypoint node.
 * Idempotent / lazy-on-view safe: each mirror node is found-or-created by (businessId, type,
 * sourceId=the RouteWaypoint/RouteAction id), so re-calls return the SAME ids and add ZERO rows;
 * edges dedup inside persistMemoryEdge. Mirror nodes are TRUSTED (tainted:false — persistMemoryNode
 * default) since they reflect our own server-set plan, not ingested content. `now` is accepted for
 * signature consistency (5a does not window on it; retained for the 5b learning loop).
 */
export async function mirrorPlanToGraph(
  identity: Identity, routeId: string, _now: Date,
): Promise<{ waypointNodeIds: string[]; actionNodeIds: string[]; edgeCount: number }> {
  const route = await prisma.route.findFirst({ where: { id: routeId, businessId: identity.businessId } });
  if (!route) throw new Error(`Route ${routeId} not found in this business scope.`);

  const waypoints = await prisma.routeWaypoint.findMany({
    where: { routeId, businessId: identity.businessId }, orderBy: { order: "asc" } });

  const waypointNodeIds: string[] = [];
  const actionNodeIds: string[] = [];
  let edgeCount = 0;
  let prevWaypointNodeId: string | undefined; // for the `next` spine along consecutive waypoints

  for (const wp of waypoints) {
    // Waypoint mirror node (collected in `order`).
    const wpNodeId = await findOrCreateMirrorNode(identity, {
      type: "waypoint", title: wp.title, body: wp.goal, confidence: 1, waypointId: wp.id, sourceId: wp.id });
    waypointNodeIds.push(wpNodeId);

    // `next` edge from the previous waypoint node to this one (deduped in persistMemoryEdge).
    if (prevWaypointNodeId !== undefined) {
      await persistMemoryEdge(identity, { fromId: prevWaypointNodeId, toId: wpNodeId, kind: "next" });
      edgeCount++;
    }
    prevWaypointNodeId = wpNodeId;

    // Action mirror nodes for this waypoint + a `references` edge from each to its waypoint node.
    const actions = await prisma.routeAction.findMany({
      where: { waypointId: wp.id, businessId: identity.businessId }, orderBy: { createdAt: "asc" } });
    for (const action of actions) {
      const nodeId = await findOrCreateMirrorNode(identity, {
        type: "action", title: `${action.employeeRole}/${action.type}`, body: action.rationale ?? "",
        confidence: 1, waypointId: wp.id, sourceId: action.id });
      actionNodeIds.push(nodeId);
      await persistMemoryEdge(identity, { fromId: nodeId, toId: wpNodeId, kind: "references" });
      edgeCount++;
    }
  }

  return { waypointNodeIds, actionNodeIds, edgeCount };
}
