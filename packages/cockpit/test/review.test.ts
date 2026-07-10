import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { recordSimulation } from "dionysus-mcp/tools/simulation";
import { listProposedDrafts, getRouteOverview, getDigestHeader, listSendQueue, listExecuted, isRenderableHttpUrl } from "../src/lib/review";

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

describe("isRenderableHttpUrl (verified-history href guard)", () => {
  it("accepts http/https and rejects javascript:/data:/garbage/empty (stored-XSS guard)", () => {
    expect(isRenderableHttpUrl("https://example.com/x")).toBe(true);
    expect(isRenderableHttpUrl("http://news.ycombinator.com/item?id=1")).toBe(true);
    expect(isRenderableHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isRenderableHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isRenderableHttpUrl("not a url")).toBe(false);
    expect(isRenderableHttpUrl("")).toBe(false);
    expect(isRenderableHttpUrl(null)).toBe(false);
  });
});
