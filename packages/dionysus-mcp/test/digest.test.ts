import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

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
