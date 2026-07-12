// Stage 6c — RouteRevision write layer: the Growth Analyst's founder-gated plan-change
// proposal. priorGoal is captured HERE (propose time) so the row is the durable
// was/now/why record independent of the graph. NEVER-AUTO: nothing in this module
// mutates a waypoint — decideRouteRevision (decide-revision.ts) applies on approval.
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type PendingRevision = {
  id: string; waypointId: string; waypointTitle: string;
  priorGoal: string; proposedGoal: string; rationale: string; createdAt: Date;
};

export async function proposeRouteRevision(
  identity: Identity,
  input: { routeId: string; waypointId: string; proposedGoal: string; rationale: string },
): Promise<{ revisionId: string } | null> {
  const businessId = identity.businessId;
  const route = await prisma.route.findFirst({ where: { id: input.routeId, businessId } });
  if (!route) throw new Error(`Route ${input.routeId} not found in this business scope.`);
  const waypoint = await prisma.routeWaypoint.findFirst({
    where: { id: input.waypointId, routeId: input.routeId, businessId } });
  if (!waypoint) throw new Error(`Waypoint ${input.waypointId} not found on this route in scope.`);
  if (waypoint.status !== "locked") throw new Error(`Only a locked waypoint can be revised (status: ${waypoint.status}).`);

  // ONE standing revision per route: a pending proposal suppresses a new one (no churn pile-up).
  const standing = await prisma.routeRevision.findFirst({ where: { businessId, routeId: input.routeId, status: "proposed" } });
  if (standing) return null;

  const row = await prisma.routeRevision.create({ data: {
    businessId, routeId: input.routeId, waypointId: input.waypointId,
    priorGoal: waypoint.goal, proposedGoal: input.proposedGoal, rationale: input.rationale, status: "proposed" } });
  return { revisionId: row.id };
}

export async function getPendingRevision(identity: Identity, routeId: string): Promise<PendingRevision | null> {
  const row = await prisma.routeRevision.findFirst({
    where: { businessId: identity.businessId, routeId, status: "proposed" }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const waypoint = await prisma.routeWaypoint.findFirst({ where: { id: row.waypointId, businessId: identity.businessId } });
  return { id: row.id, waypointId: row.waypointId, waypointTitle: waypoint?.title ?? "",
    priorGoal: row.priorGoal, proposedGoal: row.proposedGoal, rationale: row.rationale, createdAt: row.createdAt };
}
