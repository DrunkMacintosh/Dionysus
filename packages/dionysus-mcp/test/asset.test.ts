import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

describe("asset schema", () => {
  beforeAll(async () => {
    await prisma.asset.deleteMany({ where: { businessId: "biz_asset" } });
    await prisma.business.upsert({ where: { id: "biz_asset" },
      create: { id: "biz_asset", name: "Asset Co" }, update: {} });
  });

  it("persists an asset with a channel + JSON content, scoped", async () => {
    const a = await prisma.asset.create({ data: {
      businessId: "biz_asset", channel: "hackernews", kind: "post",
      contentJson: JSON.stringify({ title: "Show HN: X", body: "…" }) } });
    expect(a.routeActionId).toBeNull();                 // optional link
    expect(JSON.parse(a.contentJson).title).toBe("Show HN: X");
  });

  it("RouteAction has a nullable assetId", async () => {
    // create a minimal chain to attach to
    const obj = await prisma.objective.create({ data: { businessId: "biz_asset", kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: "biz_asset", objectiveId: obj.id, source: "composed", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: "biz_asset", routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const action = await prisma.routeAction.create({ data: { businessId: "biz_asset", waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    expect(action.assetId).toBeNull();
  });
});
