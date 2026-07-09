import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type ObjectiveInput = { kind: string; target: string; metric: string; dueDate?: string; status?: string };
export type RouteInput = { objectiveId: string; source: "case" | "composed"; caseRef?: string; status?: string };
export type WaypointInput = { routeId: string; order: number; title: string; goal: string; status?: string };
export type RouteActionInput = { waypointId: string; employeeRole: string; type: string; rationale?: string; features?: unknown };

export async function createObjective(identity: Identity, input: ObjectiveInput): Promise<{ objectiveId: string }> {
  const row = await prisma.objective.create({ data: {
    businessId: identity.businessId, kind: input.kind, target: input.target, metric: input.metric,
    dueDate: input.dueDate ? new Date(input.dueDate) : null, status: input.status ?? "active" } });
  return { objectiveId: row.id };
}

export async function persistRoute(identity: Identity, input: RouteInput): Promise<{ routeId: string }> {
  const obj = await prisma.objective.findFirst({ where: { id: input.objectiveId, businessId: identity.businessId } });
  if (!obj) throw new Error(`Objective ${input.objectiveId} not found in this business scope.`);
  const row = await prisma.route.create({ data: {
    businessId: identity.businessId, objectiveId: input.objectiveId, source: input.source,
    caseRef: input.caseRef ?? null, status: input.status ?? "proposed" } });
  return { routeId: row.id };
}

export async function persistWaypoint(identity: Identity, input: WaypointInput): Promise<{ waypointId: string }> {
  const route = await prisma.route.findFirst({ where: { id: input.routeId, businessId: identity.businessId } });
  if (!route) throw new Error(`Route ${input.routeId} not found in this business scope.`);
  const row = await prisma.routeWaypoint.create({ data: {
    businessId: identity.businessId, routeId: input.routeId, order: input.order, title: input.title,
    goal: input.goal, status: input.status ?? (input.order === 1 ? "active" : "locked") } });
  return { waypointId: row.id };
}

export async function upsertRouteAction(identity: Identity, input: RouteActionInput): Promise<{ actionId: string }> {
  const wp = await prisma.routeWaypoint.findFirst({ where: { id: input.waypointId, businessId: identity.businessId } });
  if (!wp) throw new Error(`Waypoint ${input.waypointId} not found in this business scope.`);
  const row = await prisma.routeAction.create({ data: {
    businessId: identity.businessId, waypointId: input.waypointId, employeeRole: input.employeeRole,
    type: input.type, status: "proposed", rationale: input.rationale ?? null,
    featuresJson: JSON.stringify(input.features ?? {}) } });
  return { actionId: row.id };
}
