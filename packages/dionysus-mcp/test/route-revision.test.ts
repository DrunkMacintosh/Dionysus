import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { proposeRouteRevision, getPendingRevision } from "../src/tools/route-revision.js";

const BIZ = "biz_rev_a";
const OTHER = "biz_rev_b";
let routeId = "", lockedWpId = "", activeWpId = "";

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.routeRevision.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active" } });
  routeId = route.id;
  activeWpId = (await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 1, title: "Launch", goal: "go live", status: "active" } })).id;
  lockedWpId = (await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 2, title: "Grow", goal: "old goal", status: "locked" } })).id;
});

describe("proposeRouteRevision", () => {
  it("proposes against a LOCKED waypoint, capturing priorGoal — the row is the durable was/now/why record", async () => {
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "because evidence" });
    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });
    expect(row).toMatchObject({ status: "proposed", priorGoal: "old goal", proposedGoal: "new goal", rationale: "because evidence", waypointId: lockedWpId });
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("old goal"); // NEVER-AUTO: nothing applied
  });

  it("refuses a non-locked waypoint and a cross-tenant route", async () => {
    await expect(proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: activeWpId, proposedGoal: "x", rationale: "r" })).rejects.toThrow(/locked/i);
    await expect(proposeRouteRevision({ businessId: OTHER }, { routeId, waypointId: lockedWpId, proposedGoal: "x", rationale: "r" })).rejects.toThrow(/not found/i);
    expect(await prisma.routeRevision.count()).toBe(0);
  });

  it("ONE standing revision per route: a second propose returns null and writes nothing", async () => {
    await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "a", rationale: "r" });
    const second = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "b", rationale: "r" });
    expect(second).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(1);
  });
});

describe("getPendingRevision", () => {
  it("returns the proposed revision with the waypoint title, scoped; null when none/decided", async () => {
    expect(await getPendingRevision({ businessId: BIZ }, routeId)).toBeNull();
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "why" });
    const pending = await getPendingRevision({ businessId: BIZ }, routeId);
    expect(pending).toMatchObject({ id: res!.revisionId, waypointTitle: "Grow", priorGoal: "old goal", proposedGoal: "new goal" });
    expect(await getPendingRevision({ businessId: OTHER }, routeId)).toBeNull(); // scoped
    await prisma.routeRevision.update({ where: { id: res!.revisionId }, data: { status: "rejected" } });
    expect(await getPendingRevision({ businessId: BIZ }, routeId)).toBeNull();
  });
});
