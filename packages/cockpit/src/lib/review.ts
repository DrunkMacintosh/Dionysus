import { prisma } from "dionysus-mcp/db";
import type { Identity } from "dionysus-mcp/identity";
import { buildDailyDigest } from "dionysus-mcp/tools/digest";
import { listObservations } from "dionysus-mcp/tools/memory";
import { buildCmoReport, type CmoReport } from "dionysus-mcp/tools/cmo-report";
import { mirrorPlanToGraph } from "dionysus-mcp/tools/memory-graph";
import { listCraftBeliefs, type CraftBeliefView } from "dionysus-mcp/tools/belief-graph";
import { listIntegrations, type ConnectedIntegration } from "dionysus-mcp/tools/integration";
import { getPendingRevision, type PendingRevision } from "dionysus-mcp/tools/route-revision";

export type { CmoReport };
export type { CraftBeliefView };
export type { ConnectedIntegration };

// ---------------------------------------------------------------------------
// CMO report (Task 3) — the read behind the progress-to-objective home. This is
// the request-boundary wrapper where the REAL clock enters: buildCmoReport (the
// pure grader + assembly) stays clock-injected and is tested with a fixed `now`,
// while getCmoReport stamps `new Date()` exactly once, here. Identity-scoped like
// the other cockpit reads; NOT an MCP tool (the whitelist stays 11).
// ---------------------------------------------------------------------------
export async function getCmoReport(identity: Identity): Promise<CmoReport> {
  return buildCmoReport({ businessId: identity.businessId }, new Date());
}

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
    // A cro-fix (Stage 6e) is a landing-page fix the FOUNDER applies to their OWN site by hand —
    // an apply-checklist item, NOT a copy-paste public send. An outreach-pitch (Stage 6g) is a
    // PRIVATE email the founder sends by hand from their own mail client — it has no public URL
    // to verify. An seo-audit (Stage 6h) is a deterministic on-page checklist the founder applies
    // to their OWN page by hand — apply-checklist semantics, like cro-fix. A storyboard (Stage 6i)
    // is filmed and posted by hand — no public-URL verified-send contract for a hand-posted video
    // yet. None enters the send queue. (All still reach /drafts via listProposedDrafts, inclusive.)
    if (asset.kind === "cro-fix" || asset.kind === "outreach-pitch" || asset.kind === "seo-audit" || asset.kind === "storyboard") continue;
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
// Active-objective read (Stage 6f, Task 2) — the read behind the "/setup" page.
// Returns the tenant's ONE active objective (the dogfood simplification: at most
// one active) as the founder-facing summary, or null when none is set. Scoped by
// businessId, status "active" (a done/paused objective is NOT returned), newest-
// first. Identity is a PARAMETER (cockpit convention — the page calls
// requireSession and passes it). NOT an MCP tool (the whitelist stays 11).
// ---------------------------------------------------------------------------
export type ActiveObjective = { id: string; kind: string; target: string; metric: string; createdAt: Date };

export async function getActiveObjective(identity: Identity): Promise<ActiveObjective | null> {
  const objective = await prisma.objective.findFirst({
    where: { businessId: identity.businessId, status: "active" },
    orderBy: { createdAt: "desc" } });
  if (!objective) return null;
  return { id: objective.id, kind: objective.kind, target: objective.target, metric: objective.metric, createdAt: objective.createdAt };
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

// ---------------------------------------------------------------------------
// getCraftBeliefs (stage 5c) — the read behind the "What I've learned" page. A thin,
// identity-scoped wrapper over the mcp listCraftBeliefs: the LIVE (non-superseded) craft
// beliefs Dionysus has formed from how the founder reviews drafts. These are CRAFT
// hypotheses (what the founder tends to accept), labeled with confidence — NEVER a
// performance/market metric. NOT an MCP tool (the whitelist stays 11).
// ---------------------------------------------------------------------------
export async function getCraftBeliefs(identity: Identity, limit = 50): Promise<CraftBeliefView[]> {
  return listCraftBeliefs(identity, { limit });
}

// ---------------------------------------------------------------------------
// getIntegrations (Task 6, stage 5d) — the read behind the "/connect" page. A thin,
// identity-scoped wrapper over the mcp listIntegrations returning the config-FREE
// ConnectedIntegration view: the stored secret (configEnc) NEVER surfaces here, and
// another tenant's integration is scoped out. Identity is a PARAMETER (cockpit
// convention — the page calls requireSession and passes it). NOT an MCP tool.
// ---------------------------------------------------------------------------
export async function getIntegrations(identity: Identity): Promise<ConnectedIntegration[]> {
  return listIntegrations(identity);
}

// ---------------------------------------------------------------------------
// Timeline surface (Task 4) — the read behind the "How your plan has evolved"
// page. getTimeline is the request-boundary wrapper where the REAL clock enters:
// it LAZILY mirrors the structured plan into the evolution graph on view
// (mirrorPlanToGraph, stamping new Date() here — the digest/lazy-on-view pattern),
// then reads back the mirrored waypoint spine IN ORDER (the returned waypointNodeIds
// are ordered by RouteWaypoint.order) with each waypoint's action nodes beneath it
// (grouped by the shared source waypointId, in the returned action-node order).
// Idempotent: a re-view re-runs the mirror (find-or-create), so the shape is stable
// and no rows duplicate. Each action also carries its verified-live `outcome` (Task 5) —
// the `caused` outcome node the mirror created iff the action actually shipped (executed +
// verified), else null. Identity-scoped like the other cockpit reads; NOT an MCP tool.
// ---------------------------------------------------------------------------
// A verified-live outcome (Task 5, stage 5b): the go-live FACT the mirror records for an action that
// ACTUALLY shipped (executed + verifiedAt). title = "went live on {channel}", detail = the live postedUrl.
// It is NOT a measured metric (measured outcomes need analytics — 5c). Null for any not-yet-live action.
export type TimelineOutcome = { title: string; detail: string };
export type TimelineAction = { nodeId: string; label: string; rationale: string; outcome: TimelineOutcome | null };
// Stage 6c: a founder-approved plan revision recorded under its waypoint (the `revision`
// MemoryNode's was→now→why body). Additive on TimelineWaypoint — existing consumers ignore it.
export type TimelineRevision = { body: string; createdAt: Date };
export type TimelineWaypoint = { nodeId: string; title: string; goal: string; actions: TimelineAction[]; revisions: TimelineRevision[] };
export type TimelineView = { hasRoute: boolean; waypoints: TimelineWaypoint[] };

export async function getTimeline(identity: Identity): Promise<TimelineView> {
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return { hasRoute: false, waypoints: [] };

  // Lazy mirror-on-view: the real clock enters the injected-clock mirror exactly here.
  const { waypointNodeIds, actionNodeIds } = await mirrorPlanToGraph(identity, route.id, new Date());

  // Waypoint spine, in mirror (RouteWaypoint.order) order.
  const waypoints: TimelineWaypoint[] = [];
  const byWaypointId = new Map<string, TimelineWaypoint>();
  for (const wpNodeId of waypointNodeIds) {
    const wpNode = await prisma.memoryNode.findFirst({ where: { id: wpNodeId, businessId: identity.businessId } });
    if (!wpNode) continue;
    // Stage 6c: the founder-approved revisions recorded under this waypoint (the was/now/why
    // `revision` nodes decideRouteRevision wrote), keyed by the source RouteWaypoint id, oldest-first.
    const revisionNodes = wpNode.waypointId
      ? await prisma.memoryNode.findMany({
          where: { businessId: identity.businessId, type: "revision", waypointId: wpNode.waypointId },
          orderBy: { createdAt: "asc" } })
      : [];
    const wp: TimelineWaypoint = {
      nodeId: wpNode.id, title: wpNode.title, goal: wpNode.body, actions: [],
      revisions: revisionNodes.map((r) => ({ body: r.body, createdAt: r.createdAt })) };
    waypoints.push(wp);
    if (wpNode.waypointId) byWaypointId.set(wpNode.waypointId, wp);
  }

  // Action nodes beneath their waypoint, in mirror (RouteAction.createdAt) order — each with its
  // verified-live outcome attached (the compounding loop made visible).
  for (const actionNodeId of actionNodeIds) {
    const aNode = await prisma.memoryNode.findFirst({ where: { id: actionNodeId, businessId: identity.businessId } });
    if (!aNode || !aNode.waypointId) continue;
    const wp = byWaypointId.get(aNode.waypointId);
    if (!wp) continue;
    // Task 5: the mirror created a `caused` outcome node ONLY if this action actually went live
    // (executed + verified). Traverse that edge (scoped) and attach the go-live FACT; a proposed /
    // approved / executing action has no outcome edge, so `outcome` stays null.
    let outcome: TimelineOutcome | null = null;
    const causedEdge = await prisma.memoryEdge.findFirst({
      where: { businessId: identity.businessId, fromId: aNode.id, kind: "caused" } });
    if (causedEdge) {
      const outcomeNode = await prisma.memoryNode.findFirst({
        where: { id: causedEdge.toId, businessId: identity.businessId, type: "outcome" } });
      if (outcomeNode) outcome = { title: outcomeNode.title, detail: outcomeNode.body };
    }
    wp.actions.push({ nodeId: aNode.id, label: aNode.title, rationale: aNode.body, outcome });
  }

  return { hasRoute: true, waypoints };
}

// ---------------------------------------------------------------------------
// Route-revision surface (Stage 6c, Task 5) — the read behind the "/route"
// revision card. getRoutePendingRevision finds the tenant's latest route, then
// returns its ONE standing PROPOSED revision (the Growth Analyst's founder-gated
// plan-change proposal) via the mcp getPendingRevision, tagged with its routeId.
// Identity-scoped like the other cockpit reads (another tenant's revision never
// leaks — both the route load and getPendingRevision are businessId-scoped); the
// waypoint goal stays byte-unchanged until the founder approves. NOT an MCP tool.
// ---------------------------------------------------------------------------
export type PendingRevisionCard = PendingRevision & { routeId: string };

export async function getRoutePendingRevision(identity: Identity): Promise<PendingRevisionCard | null> {
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return null;
  const pending = await getPendingRevision(identity, route.id);
  if (!pending) return null;
  return { ...pending, routeId: route.id };
}

// ---------------------------------------------------------------------------
// Pitch requests surface (Stage 6g, Task 2) — the read behind the "/pitch" page.
// listPitchRequests returns the founder's proposed `outreach-pitch` requests with the
// target fields (targetName/targetUrl) parsed DEFENSIVELY from featuresJson: a malformed
// or target-less row is SKIPPED, never a crash (the parsed-null lesson, taken to skip
// because a request with no parseable target is not renderable). `drafted` flips true
// once the nightly binds an asset. Newest-first, identity-scoped (another tenant's request
// never leaks). Founder-targeted only — these exist ONLY because the founder created them.
// NOT an MCP tool (the whitelist stays 11).
// ---------------------------------------------------------------------------
export type PitchRequestCard = { actionId: string; targetName: string; targetUrl: string; drafted: boolean; createdAt: Date };

export async function listPitchRequests(identity: Identity): Promise<PitchRequestCard[]> {
  const actions = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: "proposed", type: "outreach-pitch" },
    orderBy: { createdAt: "desc" },
  });
  const cards: PitchRequestCard[] = [];
  for (const action of actions) {
    let targetName: string | null = null;
    let targetUrl: string | null = null;
    try {
      const f = JSON.parse(action.featuresJson) as { targetName?: unknown; targetUrl?: unknown };
      targetName = typeof f.targetName === "string" ? f.targetName : null;
      targetUrl = typeof f.targetUrl === "string" ? f.targetUrl : null;
    } catch {
      /* malformed featuresJson → skip this row, never crash the list */
    }
    if (!targetName || !targetUrl) continue; // a request without a parseable target is not renderable
    cards.push({ actionId: action.id, targetName, targetUrl, drafted: action.assetId !== null, createdAt: action.createdAt });
  }
  return cards;
}

export type DigestHeader = { digestId: string; date: string; itemCount: number; reviewedAt: Date | null; openCount: number };

export async function getDigestHeader(identity: Identity): Promise<DigestHeader> {
  const { digestId } = await buildDailyDigest(identity);
  const digest = await prisma.digest.findFirst({ where: { id: digestId, businessId: identity.businessId } });
  const openCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } } });
  return { digestId, date: digest!.date, itemCount: digest!.itemCount, reviewedAt: digest!.reviewedAt, openCount };
}
