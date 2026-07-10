import { prisma } from "dionysus-mcp/db";
import type { Identity } from "dionysus-mcp/identity";
import { buildDailyDigest } from "dionysus-mcp/tools/digest";

export type DraftCard = {
  actionId: string; employeeRole: string; type: string;
  channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; rationale: string | null; editDistance: number | null;
  simulation: { engagementScore: number | null; verdict: string | null; topConcerns: string[]; confidence: number; createdAt: Date } | null;
};

export async function listProposedDrafts(identity: Identity): Promise<DraftCard[]> {
  const actions = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const cards: DraftCard[] = [];
  for (const action of actions) {
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId!, businessId: identity.businessId } });
    if (!asset) continue; // dangling pointer: not reviewable
    const wp = await prisma.routeWaypoint.findFirst({ where: { id: action.waypointId, businessId: identity.businessId } });
    let title: string | null = null;
    let body: string | null = null;
    try {
      const content = JSON.parse(asset.contentJson) as { title?: unknown; body?: unknown };
      title = typeof content.title === "string" ? content.title : null;
      body = typeof content.body === "string" ? content.body : null;
    } catch {
      body = null;
    }
    const sim = await prisma.simulationResult.findFirst({
      where: { routeActionId: action.id, businessId: identity.businessId },
      orderBy: { createdAt: "desc" } });
    let simulation: DraftCard["simulation"] = null;
    if (sim) {
      let engagementScore: number | null = null;
      let verdict: string | null = null;
      let topConcerns: string[] = [];
      try {
        const p = JSON.parse(sim.predictionJson) as { engagementScore?: unknown; verdict?: unknown; topConcerns?: unknown };
        engagementScore = typeof p.engagementScore === "number" ? p.engagementScore : null;
        verdict = typeof p.verdict === "string" ? p.verdict : null;
        topConcerns = Array.isArray(p.topConcerns) ? p.topConcerns.filter((c): c is string => typeof c === "string") : [];
      } catch {
        /* malformed prediction renders as nulls, never throws */
      }
      simulation = { engagementScore, verdict, topConcerns, confidence: sim.confidence, createdAt: sim.createdAt };
    }
    cards.push({ actionId: action.id, employeeRole: action.employeeRole, type: action.type,
      channel: asset.channel, title, body, waypointTitle: wp?.title ?? "", rationale: action.rationale,
      editDistance: action.editDistance, simulation });
  }
  return cards;
}

export type RouteOverview = {
  objective: { kind: string; target: string; metric: string; status: string } | null;
  waypoints: Array<{ order: number; title: string; goal: string; status: string;
    actions: Array<{ id: string; employeeRole: string; type: string; status: string }> }>;
};

export async function getRouteOverview(identity: Identity): Promise<RouteOverview> {
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return { objective: null, waypoints: [] };
  const objective = await prisma.objective.findFirst({ where: { id: route.objectiveId, businessId: identity.businessId } });
  const waypoints = await prisma.routeWaypoint.findMany({
    where: { routeId: route.id, businessId: identity.businessId }, orderBy: { order: "asc" } });
  const out: RouteOverview["waypoints"] = [];
  for (const wp of waypoints) {
    const actions = await prisma.routeAction.findMany({
      where: { waypointId: wp.id, businessId: identity.businessId }, orderBy: { createdAt: "asc" } });
    out.push({ order: wp.order, title: wp.title, goal: wp.goal, status: wp.status,
      actions: actions.map((a) => ({ id: a.id, employeeRole: a.employeeRole, type: a.type, status: a.status })) });
  }
  return {
    objective: objective ? { kind: objective.kind, target: objective.target, metric: objective.metric, status: objective.status } : null,
    waypoints: out,
  };
}

export type DigestHeader = { digestId: string; date: string; itemCount: number; reviewedAt: Date | null; openCount: number };

export async function getDigestHeader(identity: Identity): Promise<DigestHeader> {
  const { digestId } = await buildDailyDigest(identity);
  const digest = await prisma.digest.findFirst({ where: { id: digestId, businessId: identity.businessId } });
  const openCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } } });
  return { digestId, date: digest!.date, itemCount: digest!.itemCount, reviewedAt: digest!.reviewedAt, openCount };
}
