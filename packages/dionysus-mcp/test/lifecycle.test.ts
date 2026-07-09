import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "../src/db.js";
import { hashContent } from "../src/lib/content-hash.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";

const BIZ = "biz_lifecycle";

async function cleanTenant(businessId: string) {
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

async function makeChain(businessId: string) {
  const obj = await prisma.objective.create({ data: { businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  return { obj, route, wp, action };
}

describe("lifecycle schema", () => {
  beforeAll(async () => {
    await cleanTenant(BIZ);
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "LC" }, update: {} });
  });

  it("RouteAction carries the D29 lifecycle columns with safe defaults", async () => {
    const { action } = await makeChain(BIZ);
    expect(action.approvedAt).toBeNull();
    expect(action.approvedBy).toBeNull();
    expect(action.runId).toBeNull();
    expect(action.rejectionCount).toBe(0);
  });

  it("rejects a duplicate (routeId, order) waypoint", async () => {
    const { route } = await makeChain(BIZ);
    await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "a", goal: "g", status: "locked" } });
    await expect(prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 2, title: "b", goal: "g", status: "locked" } }))
      .rejects.toThrow(/unique/i);
  });
});

describe("content hash binding (D29)", () => {
  it("hashContent is sha256 hex over the exact string", () => {
    const s = JSON.stringify({ body: "hello" });
    expect(hashContent(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    expect(hashContent(s)).toHaveLength(64);
  });

  it("setActionAsset binds contentHash to the linked asset's stored contentJson", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "draft v1" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    const bound = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(bound!.contentHash).toBe(hashContent(asset!.contentJson));
    expect(bound!.contentHash).not.toBe("");
  });

  it("a later asset edit does NOT silently move the bound hash (mismatch stays detectable)", async () => {
    const { action } = await makeChain(BIZ);
    const { assetId } = await persistAsset({ businessId: BIZ },
      { channel: "x", kind: "post", content: { body: "original" }, routeActionId: action.id });
    await setActionAsset({ businessId: BIZ }, action.id, assetId);
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ body: "tampered" }) } });
    const after = await prisma.routeAction.findUnique({ where: { id: action.id } });
    const tampered = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(after!.contentHash).not.toBe(hashContent(tampered!.contentJson));
  });
});
