import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";

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

describe("asset tools (identity-scoped)", () => {
  let actionId = "";
  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: "biz_asset2" }, create: { id: "biz_asset2", name: "A2" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_asset_other" }, create: { id: "biz_asset_other", name: "O" }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: "biz_asset2", kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: "biz_asset2", objectiveId: obj.id, source: "composed", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: "biz_asset2", routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const action = await prisma.routeAction.create({ data: { businessId: "biz_asset2", waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    actionId = action.id;
  });

  it("persists a scoped asset and links + sets the action assetId", async () => {
    const { assetId } = await persistAsset({ businessId: "biz_asset2" },
      { channel: "x", kind: "post", content: { body: "hi" }, routeActionId: actionId });
    await setActionAsset({ businessId: "biz_asset2" }, actionId, assetId);
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(asset?.routeActionId).toBe(actionId);
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action?.assetId).toBe(assetId);
  });

  it("persistAsset rejects a routeActionId from another tenant (fail-closed)", async () => {
    await expect(persistAsset({ businessId: "biz_asset_other" },
      { channel: "x", kind: "post", content: {}, routeActionId: actionId }))
      .rejects.toThrow(/not found|scope/i);
  });
});
