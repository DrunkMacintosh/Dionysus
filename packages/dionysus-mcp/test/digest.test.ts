import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { buildDailyDigest, markDigestReviewed, utcDayKey } from "../src/tools/digest.js";

const BIZ = "biz_digest";

describe("Digest schema", () => {
  beforeAll(async () => {
    await prisma.digest.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "DG" }, update: {} });
  });

  it("persists a digest keyed uniquely by (businessId, date)", async () => {
    const d = await prisma.digest.create({ data: { businessId: BIZ, date: "2026-07-10" } });
    expect(d.reviewedAt).toBeNull();
    expect(d.itemCount).toBe(0);
    await expect(prisma.digest.create({ data: { businessId: BIZ, date: "2026-07-10" } }))
      .rejects.toThrow(/unique/i);
  });

  it("RouteAction carries digestId and editDistance defaults", async () => {
    const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    const action = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
    expect(action.digestId).toBeNull();
    expect(action.editDistance).toBeNull();
  });
});

async function reviewableAction(businessId: string, wpId: string) {
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId }, { channel: "x", kind: "post", content: { body: "b" }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return action.id;
}

describe("daily digest (D22)", () => {
  let wpId = "";
  beforeAll(async () => {
    await prisma.asset.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.routeAction.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.route.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.objective.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.digest.deleteMany({ where: { businessId: "biz_digest2" } });
    await prisma.business.upsert({ where: { id: "biz_digest2" }, create: { id: "biz_digest2", name: "D2" }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: "biz_digest2", kind: "k", target: "1", metric: "m", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: "biz_digest2", objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: "biz_digest2", routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
    wpId = wp.id;
  });

  it("utcDayKey is YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-07-10T23:59:59Z"))).toBe("2026-07-10");
  });

  it("builds idempotently: same digest twice, items batched once, count truthful", async () => {
    const a1 = await reviewableAction("biz_digest2", wpId);
    const a2 = await reviewableAction("biz_digest2", wpId);
    const first = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-10");
    const second = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-10");
    expect(second.digestId).toBe(first.digestId);
    expect(second.itemCount).toBe(2);
    const rows = await prisma.routeAction.findMany({ where: { id: { in: [a1, a2] } } });
    expect(rows.every((r) => r.digestId === first.digestId)).toBe(true);
    // an action already batched does NOT move to a later digest
    const tomorrow = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-11");
    const after = await prisma.routeAction.findUnique({ where: { id: a1 } });
    expect(after!.digestId).toBe(first.digestId);
    expect(tomorrow.itemCount).toBe(0);
  });

  it("a new draft joins TODAY's digest, not yesterday's", async () => {
    const a3 = await reviewableAction("biz_digest2", wpId);
    const today = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-11");
    const row = await prisma.routeAction.findUnique({ where: { id: a3 } });
    expect(row!.digestId).toBe(today.digestId);
    expect(today.itemCount).toBe(1);
  });

  it("markDigestReviewed stamps once, scoped, and refuses a second stamp", async () => {
    const { digestId } = await buildDailyDigest({ businessId: "biz_digest2" }, "2026-07-12");
    await markDigestReviewed({ businessId: "biz_digest2" }, digestId);
    const d = await prisma.digest.findUnique({ where: { id: digestId } });
    expect(d!.reviewedAt).toBeInstanceOf(Date);
    await expect(markDigestReviewed({ businessId: "biz_digest2" }, digestId)).rejects.toThrow(/not found|already/i);
    await expect(markDigestReviewed({ businessId: "biz_digest" }, digestId)).rejects.toThrow(/not found|already/i); // cross-tenant
  });
});
