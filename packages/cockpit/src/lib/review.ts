import { prisma } from "dionysus-mcp/db";
import type { Identity } from "dionysus-mcp/identity";
import { buildDailyDigest } from "dionysus-mcp/tools/digest";
import { listObservations } from "dionysus-mcp/tools/memory";

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

// ---------------------------------------------------------------------------
// Send queue reads (Task 5). listSendQueue = "copy the approved content, paste
// the public URL" cards for approved/executing bound actions; listExecuted =
// the verified-history section. Content is parsed defensively (the parsed-null
// lesson) so a malformed asset renders as nulls instead of throwing.
// ---------------------------------------------------------------------------
export type SendCard = {
  actionId: string; channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; status: "approved" | "executing"; postedUrl: string | null;
};

export async function listSendQueue(identity: Identity): Promise<SendCard[]> {
  const actions = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: { in: ["approved", "executing"] }, assetId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const cards: SendCard[] = [];
  for (const action of actions) {
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId!, businessId: identity.businessId } });
    if (!asset) continue; // dangling pointer: nothing to copy, not sendable
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
    cards.push({
      actionId: action.id, channel: asset.channel, title, body,
      waypointTitle: wp?.title ?? "", status: action.status as "approved" | "executing",
      postedUrl: action.postedUrl,
    });
  }
  return cards;
}

export type ExecutedCard = {
  actionId: string; channel: string | null; title: string | null;
  postedUrl: string | null; verifiedAt: Date | null; outcome: string | null;
};

export async function listExecuted(identity: Identity): Promise<ExecutedCard[]> {
  const actions = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: "executed" },
    orderBy: { verifiedAt: "desc" }, // verified history newest-first (executed rows always have verifiedAt stamped)
  });
  const cards: ExecutedCard[] = [];
  for (const action of actions) {
    let channel: string | null = null;
    let title: string | null = null;
    if (action.assetId) {
      const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
      if (asset) {
        channel = asset.channel;
        try {
          const content = JSON.parse(asset.contentJson) as { title?: unknown };
          title = typeof content.title === "string" ? content.title : null;
        } catch {
          title = null;
        }
      }
    }
    cards.push({
      actionId: action.id, channel, title,
      postedUrl: action.postedUrl, verifiedAt: action.verifiedAt, outcome: action.outcome,
    });
  }
  return cards;
}

// Render-time href guard for the verified-history link: postedUrl is FOUNDER-entered,
// so it becomes an <a href> ONLY when it parses as http(s). This blocks a stored
// javascript:/data: href (a stored-XSS vector) — such values render as plain text.
export function isRenderableHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------------------
// Radar surface (Task 7) — the read-side for the cockpit "What I noticed" page.
// listRadarObservations is a thin, identity-scoped wrapper over the mcp
// listObservations, returning the founder-facing view of radar-sensed
// market-observations newest-first. The page render-guards each sourceUrl with
// isRenderableHttpUrl (a market-observation's sourceUrl is model-emitted, even
// though runRadar checks it against the fetched set — still guarded on render).
// ---------------------------------------------------------------------------
export type ObservationView = { nodeId: string; title: string; body: string; sourceUrl: string | null; confidence: number; createdAt: Date };

export async function listRadarObservations(identity: Identity, limit = 20): Promise<ObservationView[]> {
  const cards = await listObservations(identity, limit);
  return cards.map((c) => ({
    nodeId: c.nodeId, title: c.title, body: c.body,
    sourceUrl: c.sourceUrl, confidence: c.confidence, createdAt: c.createdAt,
  }));
}

export type DigestHeader = { digestId: string; date: string; itemCount: number; reviewedAt: Date | null; openCount: number };

export async function getDigestHeader(identity: Identity): Promise<DigestHeader> {
  const { digestId } = await buildDailyDigest(identity);
  const digest = await prisma.digest.findFirst({ where: { id: digestId, businessId: identity.businessId } });
  const openCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } } });
  return { digestId, date: digest!.date, itemCount: digest!.itemCount, reviewedAt: digest!.reviewedAt, openCount };
}
