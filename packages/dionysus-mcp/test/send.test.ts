import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_send";

async function freshWaypoint(businessId: string): Promise<string> {
  const obj = await prisma.objective.create({ data: { businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  return wp.id;
}

describe("RouteAction send columns (schema)", () => {
  beforeAll(async () => {
    await prisma.routeAction.deleteMany({ where: { businessId: BIZ } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: BIZ } });
    await prisma.route.deleteMany({ where: { businessId: BIZ } });
    await prisma.objective.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "Send Co" }, update: {} });
  });

  it("a fresh RouteAction has postedUrl, verifiedAt and outcome all null (§10)", async () => {
    const wpId = await freshWaypoint(BIZ);
    const action = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
    expect(action.postedUrl).toBeNull();
    expect(action.verifiedAt).toBeNull();
    expect(action.outcome).toBeNull();
  });
});
