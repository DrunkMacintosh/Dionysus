import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { OBJECTIVE_STATUSES, ROUTE_STATUSES, WAYPOINT_STATUSES } from "../src/tools/plan.js";

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

describe("plan tools (identity-scoped)", () => {
  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: "biz_plan2" }, create: { id: "biz_plan2", name: "P2" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_other" }, create: { id: "biz_other", name: "Other" }, update: {} });
  });

  it("creates objective→route→waypoint→proposed action via tools, scoped", async () => {
    const { objectiveId } = await createObjective({ businessId: "biz_plan2" },
      { kind: "waitlist", target: "500", metric: "signups" });
    const { routeId } = await persistRoute({ businessId: "biz_plan2" },
      { objectiveId, source: "case", caseRef: "case_x" });
    const { waypointId } = await persistWaypoint({ businessId: "biz_plan2" },
      { routeId, order: 1, title: "T", goal: "G" });
    const { actionId } = await upsertRouteAction({ businessId: "biz_plan2" },
      { waypointId, employeeRole: "copywriter", type: "post", rationale: "why", features: { channel: "x" } });
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a?.status).toBe("proposed");
    expect(a?.rationale).toBe("why");
    const wp = await prisma.routeWaypoint.findUnique({ where: { id: waypointId } });
    expect(wp?.status).toBe("active"); // order 1 → active default
  });

  it("persistRoute rejects an objective owned by another tenant (fail-closed)", async () => {
    const { objectiveId } = await createObjective({ businessId: "biz_other" },
      { kind: "k", target: "1", metric: "m" });
    await expect(persistRoute({ businessId: "biz_plan2" }, { objectiveId, source: "composed" }))
      .rejects.toThrow(/not found|scope/i);
  });
});

describe("status-enum hardening (function layer)", () => {
  const TEST_BIZ = "biz_enum";
  beforeAll(async () => {
    await prisma.business.upsert({ where: { id: TEST_BIZ },
      create: { id: TEST_BIZ, name: "Enum Co" }, update: {} });
  });

  it("createObjective rejects an out-of-enum status", async () => {
    await expect(createObjective({ businessId: TEST_BIZ },
      { kind: "k", target: "1", metric: "m", status: "garbage" as never }))
      .rejects.toThrow(/invalid objective status/i);
  });

  it("persistRoute and persistWaypoint reject out-of-enum statuses", async () => {
    const { objectiveId } = await createObjective({ businessId: TEST_BIZ }, { kind: "k", target: "1", metric: "m" });
    await expect(persistRoute({ businessId: TEST_BIZ }, { objectiveId, source: "case", status: "garbage" as never }))
      .rejects.toThrow(/invalid route status/i);
    const { routeId } = await persistRoute({ businessId: TEST_BIZ }, { objectiveId, source: "case" });
    await expect(persistWaypoint({ businessId: TEST_BIZ }, { routeId, order: 91, title: "t", goal: "g", status: "garbage" as never }))
      .rejects.toThrow(/invalid waypoint status/i);
  });

  it("exports the ratified enums", () => {
    expect(OBJECTIVE_STATUSES).toEqual(["active", "paused", "done"]);
    expect(ROUTE_STATUSES).toEqual(["proposed", "active", "done"]);
    expect(WAYPOINT_STATUSES).toEqual(["locked", "active", "done"]);
  });
});
