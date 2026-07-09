import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

describe("plan-layer schema", () => {
  beforeAll(async () => {
    await prisma.routeAction.deleteMany({ where: { businessId: "biz_plan" } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: "biz_plan" } });
    await prisma.route.deleteMany({ where: { businessId: "biz_plan" } });
    await prisma.objective.deleteMany({ where: { businessId: "biz_plan" } });
    await prisma.business.upsert({ where: { id: "biz_plan" },
      create: { id: "biz_plan", name: "Plan Co" }, update: {} });
  });

  it("persists an objective → route → waypoint → action chain, all scoped", async () => {
    const obj = await prisma.objective.create({ data: {
      businessId: "biz_plan", kind: "signups", target: "100", metric: "users", status: "active" } });
    const route = await prisma.route.create({ data: {
      businessId: "biz_plan", objectiveId: obj.id, source: "case", status: "proposed" } });
    const wp = await prisma.routeWaypoint.create({ data: {
      businessId: "biz_plan", routeId: route.id, order: 1, title: "Launch on HN",
      goal: "First 20 signups", status: "active" } });
    const action = await prisma.routeAction.create({ data: {
      businessId: "biz_plan", waypointId: wp.id, employeeRole: "copywriter", type: "post",
      status: "proposed", contentHash: "", featuresJson: JSON.stringify({ channel: "hackernews" }) } });
    expect(obj.dueDate).toBeNull();               // optional
    expect(route.objectiveId).toBe(obj.id);
    expect(wp.order).toBe(1);
    expect(JSON.parse(action.featuresJson).channel).toBe("hackernews");
    expect(action.status).toBe("proposed");
  });
});
