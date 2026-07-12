import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { recordSimulation } from "dionysus-mcp/tools/simulation";
import { recordObservation } from "dionysus-mcp/tools/memory";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "dionysus-mcp/tools/plan";
import { approveAction, startExecution, completeExecution } from "dionysus-mcp/tools/lifecycle";
import { listProposedDrafts, getRouteOverview, getDigestHeader, listSendQueue, listExecuted, isRenderableHttpUrl, listRadarObservations, getCmoReport, getTimeline, getCraftBeliefs, getIntegrations, getRoutePendingRevision } from "../src/lib/review";
import { persistCraftBelief } from "dionysus-mcp/tools/belief-graph";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { proposeRouteRevision } from "dionysus-mcp/tools/route-revision";
import { decideRouteRevision } from "dionysus-mcp/tools/decide-revision";
import { mirrorPlanToGraph } from "dionysus-mcp/tools/memory-graph";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";

const A = { businessId: "biz_cockpit_rev" };
const B = { businessId: "biz_cockpit_rev_other" };
let boundActionId = "";

beforeAll(async () => {
  for (const id of [A.businessId, B.businessId]) {
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: A.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: A.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: A.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  const bound = await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", rationale: "launch" } });
  const { assetId } = await persistAsset(A, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" }, routeActionId: bound.id });
  await setActionAsset(A, bound.id, assetId);
  boundActionId = bound.id;
  // a proposed action with NO asset must not appear as a reviewable draft
  await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
});

describe("review service", () => {
  it("lists only proposed actions WITH a bound asset, with parsed content", async () => {
    const drafts = await listProposedDrafts(A);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ actionId: boundActionId, channel: "hackernews", title: "Show HN", body: "We built X", waypointTitle: "Launch" });
  });

  it("attaches the LATEST simulation as a labeled prediction, parsed defensively", async () => {
    await recordSimulation(A, { routeActionId: boundActionId, engine: "focus_group",
      prediction: { engagementScore: 3, verdict: "old", topConcerns: [] }, confidence: 0.3 });
    await recordSimulation(A, { routeActionId: boundActionId, engine: "focus_group",
      prediction: { engagementScore: 7, verdict: "sharpened - ship it", topConcerns: ["length"] }, confidence: 0.65 });
    const drafts = await listProposedDrafts(A);
    const card = drafts.find((d) => d.actionId === boundActionId)!;
    expect(card.simulation).not.toBeNull();
    expect(card.simulation!.verdict).toBe("sharpened - ship it"); // latest wins
    expect(card.simulation!.engagementScore).toBe(7);
    expect(card.simulation!.confidence).toBeCloseTo(0.65);
  });

  it("route overview assembles objective -> waypoints -> actions", async () => {
    const view = await getRouteOverview(A);
    expect(view.objective?.kind).toBe("signups");
    expect(view.waypoints).toHaveLength(1);
    expect(view.waypoints[0]!.actions.length).toBe(2);
  });

  it("another tenant sees nothing (identity-scoped reads)", async () => {
    expect(await listProposedDrafts(B)).toHaveLength(0);
    expect((await getRouteOverview(B)).objective).toBeNull();
  });

  it("digest header builds today's digest lazily and counts open drafts", async () => {
    const header = await getDigestHeader(A);
    expect(header.digestId).toBeTruthy();
    expect(header.openCount).toBeGreaterThanOrEqual(1); // the bound draft from the fixture
    expect(header.reviewedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Send queue service — the cockpit read-side for Task 5's "copy → paste → verify"
// page. listSendQueue surfaces approved/executing bound actions (content to copy +
// the postedUrl-in-progress); listExecuted is the verified-history section.
// ---------------------------------------------------------------------------
const SQ = { businessId: "biz_cockpit_sendq" };
const SQO = { businessId: "biz_cockpit_sendq_other" };

describe("send queue service (listSendQueue / listExecuted)", () => {
  let approvedId = "";
  let executingId = "";
  let executedId = "";

  beforeAll(async () => {
    for (const id of [SQ.businessId, SQO.businessId]) {
      await prisma.asset.deleteMany({ where: { businessId: id } });
      await prisma.routeAction.deleteMany({ where: { businessId: id } });
      await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
      await prisma.route.deleteMany({ where: { businessId: id } });
      await prisma.objective.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }
    const obj = await prisma.objective.create({ data: { businessId: SQ.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: SQ.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: SQ.businessId, routeId: route.id, order: 1, title: "Ship it", goal: "go live", status: "active" } });

    // Assets can only be bound while "proposed" (setActionAsset's bind-guard); bind
    // first, then move status directly to the state each fixture needs to exercise.
    const seedBound = async (content: { title?: string; body?: string }) => {
      const action = await prisma.routeAction.create({ data: { businessId: SQ.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
      const { assetId } = await persistAsset(SQ, { channel: "hackernews", kind: "post", content, routeActionId: action.id });
      await setActionAsset(SQ, action.id, assetId);
      return action.id;
    };

    approvedId = await seedBound({ title: "Show HN", body: "We built X" });
    await prisma.routeAction.update({ where: { id: approvedId }, data: { status: "approved" } });

    executingId = await seedBound({ title: "Launch thread", body: "going live now" });
    await prisma.routeAction.update({ where: { id: executingId }, data: { status: "executing", postedUrl: "https://news.ycombinator.com/item?id=123" } });

    executedId = await seedBound({ title: "Done post", body: "shipped" });
    await prisma.routeAction.update({ where: { id: executedId }, data: { status: "executed", postedUrl: "https://example.com/live", verifiedAt: new Date(), outcome: "verified" } });

    // A still-proposed bound draft must NOT appear in the send queue (not yet approved).
    await seedBound({ title: "Draft only", body: "still in review" });
  });

  it("lists approved + executing bound actions with parsed content and passthrough postedUrl", async () => {
    const queue = await listSendQueue(SQ);
    expect(queue.map((c) => c.actionId).sort()).toEqual([approvedId, executingId].sort());
    const approved = queue.find((c) => c.actionId === approvedId)!;
    expect(approved).toMatchObject({ channel: "hackernews", title: "Show HN", body: "We built X", waypointTitle: "Ship it", status: "approved", postedUrl: null });
    const executing = queue.find((c) => c.actionId === executingId)!;
    expect(executing).toMatchObject({ status: "executing", postedUrl: "https://news.ycombinator.com/item?id=123" });
  });

  it("listExecuted returns executed actions as verified history", async () => {
    const executed = await listExecuted(SQ);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ actionId: executedId, channel: "hackernews", title: "Done post", postedUrl: "https://example.com/live", outcome: "verified" });
    expect(executed[0]!.verifiedAt).toBeInstanceOf(Date);
  });

  it("another tenant sees neither the queue nor the executed history (identity-scoped)", async () => {
    expect(await listSendQueue(SQO)).toHaveLength(0);
    expect(await listExecuted(SQO)).toHaveLength(0);
  });
});

// Verified history is ordered by verifiedAt desc ("most-recently-went-live first"),
// NOT createdAt. This fixture deliberately inverts the two orders: the row created
// FIRST gets the LATER verifiedAt, so a lingering createdAt sort would fail this test.
const EO = { businessId: "biz_cockpit_execorder" };

describe("listExecuted ordering (verified history newest-first by verifiedAt)", () => {
  let laterId = "";
  let earlierId = "";

  beforeAll(async () => {
    await prisma.asset.deleteMany({ where: { businessId: EO.businessId } });
    await prisma.routeAction.deleteMany({ where: { businessId: EO.businessId } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: EO.businessId } });
    await prisma.route.deleteMany({ where: { businessId: EO.businessId } });
    await prisma.objective.deleteMany({ where: { businessId: EO.businessId } });
    await prisma.business.upsert({ where: { id: EO.businessId }, create: { id: EO.businessId, name: EO.businessId }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: EO.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: EO.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: EO.businessId, routeId: route.id, order: 1, title: "Ship it", goal: "go live", status: "active" } });

    // Created first -> later verifiedAt (June); created second -> earlier verifiedAt (Jan).
    const laterVerified = await prisma.routeAction.create({ data: { businessId: EO.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", postedUrl: "https://example.com/later", outcome: "verified" } });
    const earlierVerified = await prisma.routeAction.create({ data: { businessId: EO.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", postedUrl: "https://example.com/earlier", outcome: "verified" } });
    await prisma.routeAction.update({ where: { id: laterVerified.id }, data: { verifiedAt: new Date("2026-06-01T00:00:00.000Z") } });
    await prisma.routeAction.update({ where: { id: earlierVerified.id }, data: { verifiedAt: new Date("2026-01-01T00:00:00.000Z") } });
    laterId = laterVerified.id;
    earlierId = earlierVerified.id;
  });

  it("returns the row with the later verifiedAt first", async () => {
    const executed = await listExecuted(EO);
    expect(executed.map((c) => c.actionId)).toEqual([laterId, earlierId]);
  });
});

// ---------------------------------------------------------------------------
// Radar surface service — the cockpit read-side for the "What I noticed" page.
// listRadarObservations is a thin, identity-scoped wrapper over the mcp
// listObservations, returning market-observations newest-first with view fields.
// ---------------------------------------------------------------------------
const RAD = { businessId: "biz_cockpit_radar" };
const RADO = { businessId: "biz_cockpit_radar_other" };

describe("radar surface service (listRadarObservations)", () => {
  beforeAll(async () => {
    for (const id of [RAD.businessId, RADO.businessId]) {
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }
    await recordObservation(RAD, { title: "Older signal", body: "seen first", sourceUrl: "https://news.ycombinator.com/item?id=1", confidence: 0.4 });
    await new Promise((r) => setTimeout(r, 5)); // strictly later createdAt so newest-first is deterministic
    await recordObservation(RAD, { title: "Newer signal", body: "seen second", sourceUrl: "https://news.ycombinator.com/item?id=2", confidence: 0.8 });
  });

  it("returns market-observations newest-first with the view fields", async () => {
    const obs = await listRadarObservations(RAD);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ title: "Newer signal", body: "seen second", sourceUrl: "https://news.ycombinator.com/item?id=2", confidence: 0.8 });
    expect(obs[1]!.title).toBe("Older signal"); // newest-first
    expect(obs[0]!.nodeId).toBeTruthy();
    expect(obs[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("another tenant sees no observations (identity-scoped reads)", async () => {
    expect(await listRadarObservations(RADO)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CMO report service (getCmoReport) — the read behind the progress-to-objective
// home. A thin request-boundary wrapper over buildCmoReport that stamps the real
// clock (new Date()). The honesty invariant (§3/D21/D31) surfaces here: at 4f
// analyticsConnected is always false and NO verdict ever claims the metric moved.
// ---------------------------------------------------------------------------
const CMO = { businessId: "biz_cockpit_cmo" };
const CMOO = { businessId: "biz_cockpit_cmo_other" };

describe("cmo report service (getCmoReport)", () => {
  beforeAll(async () => {
    for (const id of [CMO.businessId, CMOO.businessId]) {
      await prisma.asset.deleteMany({ where: { businessId: id } });
      await prisma.routeAction.deleteMany({ where: { businessId: id } });
      await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
      await prisma.route.deleteMany({ where: { businessId: id } });
      await prisma.objective.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }
    const obj = await prisma.objective.create({ data: { businessId: CMO.businessId, kind: "growth", target: "500", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: CMO.businessId, objectiveId: obj.id, source: "case", status: "active" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: CMO.businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
    // Assets bind only while "proposed" (setActionAsset's bind-guard): bind first,
    // then move the action to executed+verified so it shows up in whatRan this week.
    const action = await prisma.routeAction.create({ data: { businessId: CMO.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    const { assetId } = await persistAsset(CMO, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "shipped" }, routeActionId: action.id });
    await setActionAsset(CMO, action.id, assetId);
    await prisma.routeAction.update({ where: { id: action.id }, data: { status: "executed", postedUrl: "https://example.com/live", verifiedAt: new Date(), outcome: "verified" } });
  });

  it("returns a CmoReport for a tenant with an executed send; honesty holds (analytics off, no metric-move claim)", async () => {
    const report = await getCmoReport(CMO);
    expect(report.objective).not.toBeNull();
    expect(report.objective!.metric).toBe("signups");
    expect(report.whatRan).toHaveLength(1); // the in-week verified send
    expect(report.whatRan[0]!.title).toBe("Show HN");
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false); // §3/D21 invariant
  });

  it("a tenant with no route gets objective null + a getting-started verdict", async () => {
    const report = await getCmoReport(CMOO);
    expect(report.objective).toBeNull();
    expect(report.verdict.state).toBe("getting-started");
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(report.analyticsConnected).toBe(false);
  });
});

describe("isRenderableHttpUrl (verified-history href guard)", () => {
  it("accepts http/https and rejects javascript:/data:/garbage/empty (stored-XSS guard)", () => {
    expect(isRenderableHttpUrl("https://example.com/x")).toBe(true);
    expect(isRenderableHttpUrl("http://news.ycombinator.com/item?id=1")).toBe(true);
    expect(isRenderableHttpUrl("https://example.com/p")).toBe(true);
    expect(isRenderableHttpUrl("http://localhost:3000/x")).toBe(true);
    expect(isRenderableHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isRenderableHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    // Regression-lock extra vectors so a future denylist refactor can't slip them through.
    expect(isRenderableHttpUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isRenderableHttpUrl("mailto:x@y.com")).toBe(false);
    expect(isRenderableHttpUrl("//evil.com")).toBe(false); // protocol-relative: new URL throws with no base
    expect(isRenderableHttpUrl(" javascript:alert(1)")).toBe(false); // leading space
    expect(isRenderableHttpUrl("not a url")).toBe(false);
    expect(isRenderableHttpUrl("")).toBe(false);
    expect(isRenderableHttpUrl(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timeline service (getTimeline) — the read behind the "How your plan has evolved"
// page. getTimeline finds the latest route, LAZILY mirrors the structured plan into
// the evolution graph (mirrorPlanToGraph at the request boundary), then reads the
// mirrored waypoint spine (in order) with each waypoint's action nodes beneath it.
// The mirror is idempotent, so a re-view (second call) is stable — same shape, no dup.
// ---------------------------------------------------------------------------
const TL = { businessId: "biz_cockpit_timeline" };
const TLO = { businessId: "biz_cockpit_timeline_other" };

describe("timeline service (getTimeline — lazy mirror-on-view)", () => {
  beforeAll(async () => {
    for (const id of [TL.businessId, TLO.businessId]) {
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
      await prisma.routeAction.deleteMany({ where: { businessId: id } });
      await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
      await prisma.route.deleteMany({ where: { businessId: id } });
      await prisma.objective.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }
    // Seed a real structured plan via the plan tools: 2 ordered waypoints with actions.
    const { objectiveId } = await createObjective(TL, { kind: "signups", target: "100", metric: "users" });
    const { routeId } = await persistRoute(TL, { objectiveId, source: "case" });
    const { waypointId: wp1 } = await persistWaypoint(TL, { routeId, order: 1, title: "Launch week", goal: "20 signups" });
    const { waypointId: wp2 } = await persistWaypoint(TL, { routeId, order: 2, title: "Iterate", goal: "double down" });
    await upsertRouteAction(TL, { waypointId: wp1, employeeRole: "copywriter", type: "post", rationale: "hn launch" });
    await upsertRouteAction(TL, { waypointId: wp1, employeeRole: "designer", type: "asset", rationale: "og image" });
    await upsertRouteAction(TL, { waypointId: wp2, employeeRole: "copywriter", type: "post", rationale: "follow up" });
  });

  it("mirrors the plan and returns the waypoint spine in order with actions beneath each", async () => {
    const view = await getTimeline(TL);
    expect(view.hasRoute).toBe(true);
    expect(view.waypoints).toHaveLength(2);

    const [first, second] = view.waypoints;
    expect(first!).toMatchObject({ title: "Launch week", goal: "20 signups" });
    expect(first!.nodeId).toBeTruthy();
    expect(first!.actions).toHaveLength(2);
    expect(first!.actions[0]).toMatchObject({ label: "copywriter/post", rationale: "hn launch" });
    expect(first!.actions[1]).toMatchObject({ label: "designer/asset", rationale: "og image" });
    expect(first!.actions[0]!.nodeId).toBeTruthy();

    expect(second!).toMatchObject({ title: "Iterate", goal: "double down" });
    expect(second!.actions).toHaveLength(1);
    expect(second!.actions[0]).toMatchObject({ label: "copywriter/post", rationale: "follow up" });
  });

  it("is idempotent on re-view: a second call returns the same shape and node ids (no dup)", async () => {
    const firstView = await getTimeline(TL);
    const secondView = await getTimeline(TL);
    expect(secondView.hasRoute).toBe(true);
    expect(secondView.waypoints).toHaveLength(2);
    expect(secondView.waypoints[0]!.actions).toHaveLength(2);
    expect(secondView.waypoints[1]!.actions).toHaveLength(1);
    // Stable ids across views — the mirror found existing nodes, it did not create new ones.
    expect(secondView.waypoints.map((w) => w.nodeId)).toEqual(firstView.waypoints.map((w) => w.nodeId));
    expect(secondView.waypoints[0]!.actions.map((a) => a.nodeId)).toEqual(firstView.waypoints[0]!.actions.map((a) => a.nodeId));
  });

  it("a tenant with no route gets hasRoute:false and an empty spine", async () => {
    const view = await getTimeline(TLO);
    expect(view.hasRoute).toBe(false);
    expect(view.waypoints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timeline outcomes (Task 5) — the compounding loop made visible. getTimeline
// attaches each action's `caused` outcome node (the verified-live FACT the mirror
// creates for an executed+verified send) so the page can render "✓ went live …"
// beneath an action that actually shipped. §13 honesty gate lives in the mirror:
// only an executed+verified action earns an outcome; a proposed action stays null.
// ---------------------------------------------------------------------------
const TLX = { businessId: "biz_cockpit_timeline_outcome" };
const TLXO = { businessId: "biz_cockpit_timeline_outcome_other" };

describe("timeline outcomes (getTimeline attaches verified-live outcomes)", () => {
  const POSTED_URL = "https://news.ycombinator.com/item?id=verified5b";

  beforeAll(async () => {
    for (const id of [TLX.businessId, TLXO.businessId]) {
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
      await prisma.asset.deleteMany({ where: { businessId: id } });
      await prisma.routeAction.deleteMany({ where: { businessId: id } });
      await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
      await prisma.route.deleteMany({ where: { businessId: id } });
      await prisma.objective.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }

    // TLX: one waypoint, two actions — one driven executed+verified (earns an outcome),
    // one left proposed (no outcome). Seeded via the real plan tools.
    const { objectiveId } = await createObjective(TLX, { kind: "signups", target: "100", metric: "users" });
    const { routeId } = await persistRoute(TLX, { objectiveId, source: "case" });
    const { waypointId } = await persistWaypoint(TLX, { routeId, order: 1, title: "Launch week", goal: "20 signups" });
    const { actionId: executedActionId } = await upsertRouteAction(TLX, { waypointId, employeeRole: "copywriter", type: "post", rationale: "hn launch" });
    await upsertRouteAction(TLX, { waypointId, employeeRole: "designer", type: "asset", rationale: "og image" });

    // Drive the copywriter/post action through the REAL lifecycle to executed, then stamp the
    // verified-send fact (verifiedAt + live URL) — exactly what earns an outcome node in the mirror.
    const { assetId } = await persistAsset(TLX, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" }, routeActionId: executedActionId });
    await setActionAsset(TLX, executedActionId, assetId);
    await approveAction(TLX, { routeActionId: executedActionId, principal: "founder" });
    await startExecution(TLX, { routeActionId: executedActionId, runId: "run_tl_5b" });
    await completeExecution(TLX, { routeActionId: executedActionId });
    await prisma.routeAction.update({ where: { id: executedActionId }, data: { verifiedAt: new Date(), postedUrl: POSTED_URL } });

    // TLXO: a second tenant with its own route + one proposed action — proves TLX's verified-live
    // fact never leaks across the businessId boundary (its action's outcome must stay null).
    const { objectiveId: otherObj } = await createObjective(TLXO, { kind: "signups", target: "100", metric: "users" });
    const { routeId: otherRoute } = await persistRoute(TLXO, { objectiveId: otherObj, source: "case" });
    const { waypointId: otherWp } = await persistWaypoint(TLXO, { routeId: otherRoute, order: 1, title: "Their launch", goal: "their goal" });
    await upsertRouteAction(TLXO, { waypointId: otherWp, employeeRole: "copywriter", type: "post", rationale: "their draft" });
  });

  it("attaches the verified-live outcome to the executed action and null to the proposed one", async () => {
    const view = await getTimeline(TLX);
    expect(view.hasRoute).toBe(true);
    expect(view.waypoints).toHaveLength(1);
    const actions = view.waypoints[0]!.actions;
    expect(actions).toHaveLength(2);

    const executed = actions.find((a) => a.label === "copywriter/post")!;
    expect(executed.outcome).not.toBeNull();
    expect(executed.outcome!.title).toBe("went live on hackernews"); // channel from the bound asset
    expect(executed.outcome!.detail).toBe(POSTED_URL);                // the verified-live URL, not a metric

    const proposed = actions.find((a) => a.label === "designer/asset")!;
    expect(proposed.outcome).toBeNull(); // a proposed action has not gone live — no outcome
  });

  it("another tenant's action carries no outcome — TLX's verified-live fact does not leak (identity-scoped)", async () => {
    const view = await getTimeline(TLXO);
    expect(view.hasRoute).toBe(true);
    expect(view.waypoints).toHaveLength(1);
    expect(view.waypoints[0]!.actions[0]!.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Craft beliefs service (getCraftBeliefs) — the read behind the "What I've learned"
// page. A thin, identity-scoped wrapper over the mcp listCraftBeliefs: the LIVE craft
// hypotheses Dionysus has formed from how the founder reviews drafts. Scoped like the
// other cockpit reads — another tenant's belief never leaks.
// ---------------------------------------------------------------------------
describe("getCraftBeliefs", () => {
  beforeAll(async () => {
    for (const id of [A.businessId, B.businessId]) {
      await prisma.memoryNode.deleteMany({ where: { businessId: id, type: "learning" } });
    }
    await persistCraftBelief(A, { role: "copywriter", featureKey: "channel=linkedin", belief: { confidence: 0.8, stance: "positive", lowConfidence: false, summary: "Tends to approve (5 accepted as-is, 0 rejected)." } });
    await persistCraftBelief(B, { role: "copywriter", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "other tenant belief" } });
  });

  it("returns the identity's live beliefs, scoped — another tenant's belief never leaks", async () => {
    const beliefs = await getCraftBeliefs(A);
    expect(beliefs.map((b) => b.body)).toContain("Tends to approve (5 accepted as-is, 0 rejected).");
    expect(beliefs.some((b) => b.body === "other tenant belief")).toBe(false); // B is scoped out
  });
});

// ---------------------------------------------------------------------------
// Integrations service (getIntegrations) — the read behind the "/connect" page.
// A thin, identity-scoped wrapper over the mcp listIntegrations returning the
// config-FREE ConnectedIntegration view: the stored secret (configEnc) never
// surfaces, and another tenant's integration is scoped out.
// ---------------------------------------------------------------------------
describe("getIntegrations", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
  beforeEach(async () => {
    await prisma.integration.deleteMany({ where: { businessId: A.businessId } });
    await prisma.integration.deleteMany({ where: { businessId: B.businessId } });
  });

  it("returns the identity's integrations WITHOUT any config, scoped — another tenant's is excluded", async () => {
    await connectIntegration(A, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "sekret" } });
    await connectIntegration(B, { kind: "analytics", provider: "http-json", metric: "x", config: { apiKey: "other" } });
    const list = await getIntegrations(A);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("configEnc");
    expect(JSON.stringify(list)).not.toContain("sekret"); // config never surfaces
    expect(list.some((i) => i.metric === "x")).toBe(false); // B scoped out
  });
});

// ---------------------------------------------------------------------------
// Route-revision surface (Stage 6c, Task 5) — the read-side for the "/route"
// revision card + the "/timeline" revisions line. getRoutePendingRevision finds
// the tenant's latest route and returns its standing PROPOSED revision (scoped —
// another tenant's revision never leaks); getTimeline additionally carries each
// waypoint's `revision` MemoryNodes (the was/now/why record the approve wrote).
// ---------------------------------------------------------------------------
const REV = { businessId: "biz_cockpit_revision" };
const REVO = { businessId: "biz_cockpit_revision_other" };

describe("route-revision surface (getRoutePendingRevision + timeline revisions)", () => {
  let routeId = "";
  let lockedWpId = "";

  beforeEach(async () => {
    for (const id of [REV.businessId, REVO.businessId]) {
      await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
      await prisma.memoryNode.deleteMany({ where: { businessId: id } });
      await prisma.routeRevision.deleteMany({ where: { businessId: id } });
      await prisma.routeAction.deleteMany({ where: { businessId: id } });
      await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
      await prisma.route.deleteMany({ where: { businessId: id } });
      await prisma.objective.deleteMany({ where: { businessId: id } });
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }
    // A (REV): a route with a next LOCKED waypoint the analyst could re-personalize.
    const obj = await prisma.objective.create({ data: { businessId: REV.businessId, kind: "growth", target: "100", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: REV.businessId, objectiveId: obj.id, source: "composed", status: "active" } });
    routeId = route.id;
    await prisma.routeWaypoint.create({ data: { businessId: REV.businessId, routeId, order: 1, title: "Launch", goal: "go live", status: "active" } });
    lockedWpId = (await prisma.routeWaypoint.create({ data: { businessId: REV.businessId, routeId, order: 2, title: "Grow", goal: "old goal", status: "locked" } })).id;

    // B (REVO): its OWN route with its OWN standing proposed revision — so A's scoped read is
    // NON-VACUOUS: there is a real foreign revision that must NOT leak into A's card.
    const objB = await prisma.objective.create({ data: { businessId: REVO.businessId, kind: "growth", target: "100", metric: "signups", status: "active" } });
    const routeB = await prisma.route.create({ data: { businessId: REVO.businessId, objectiveId: objB.id, source: "composed", status: "active" } });
    const lockedWpB = (await prisma.routeWaypoint.create({ data: { businessId: REVO.businessId, routeId: routeB.id, order: 1, title: "Their grow", goal: "their goal", status: "locked" } })).id;
    await proposeRouteRevision(REVO, { routeId: routeB.id, waypointId: lockedWpB, proposedGoal: "their new goal", rationale: "their reason" });
  });

  it("returns A's proposed revision (scoped — B's never leaks), null when none and after a decide", async () => {
    // B already has a standing proposed revision (seeded above); A has none yet → null (non-vacuous scope).
    expect(await getRoutePendingRevision(REV)).toBeNull();

    const res = await proposeRouteRevision(REV, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "because evidence" });
    const pending = await getRoutePendingRevision(REV);
    expect(pending).toMatchObject({
      id: res!.revisionId, routeId, waypointTitle: "Grow",
      priorGoal: "old goal", proposedGoal: "new goal", rationale: "because evidence",
    });

    // After the founder decides, the card clears.
    await decideRouteRevision(REV, { revisionId: res!.revisionId, decision: "rejected" }, new Date());
    expect(await getRoutePendingRevision(REV)).toBeNull();
  });

  it("after approve, getTimeline carries the revision under its waypoint with the was/now body", async () => {
    const res = await proposeRouteRevision(REV, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "because evidence" });
    // Seed the mirror first so the approve's mirror-refresh path runs (getTimeline mirrors lazily anyway).
    await mirrorPlanToGraph(REV, routeId, new Date());
    await decideRouteRevision(REV, { revisionId: res!.revisionId, decision: "approved" }, new Date());

    const timeline = await getTimeline(REV);
    const grown = timeline.waypoints.find((w) => w.title === "Grow")!;
    expect(grown.revisions).toHaveLength(1);
    expect(grown.revisions[0]!.body).toContain("Goal was:");
    expect(grown.revisions[0]!.body).toContain("old goal");
    expect(grown.revisions[0]!.createdAt).toBeInstanceOf(Date);

    // Scoped: A's revision never surfaces on B's timeline.
    const otherTimeline = await getTimeline(REVO);
    expect(otherTimeline.waypoints.every((w) => w.revisions.length === 0)).toBe(true);
  });
});
