import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { recordSimulation } from "dionysus-mcp/tools/simulation";
import { listProposedDrafts, getRouteOverview, getDigestHeader } from "../src/lib/review";

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
