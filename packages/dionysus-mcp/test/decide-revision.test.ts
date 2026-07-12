import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { proposeRouteRevision } from "../src/tools/route-revision.js";
import { decideRouteRevision } from "../src/tools/decide-revision.js";
import { mirrorPlanToGraph } from "../src/tools/memory-graph.js";

const BIZ = "biz_decide_a";
const OTHER = "biz_decide_b";
let routeId = "", lockedWpId = "";

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
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
  await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 1, title: "Launch", goal: "go live", status: "active" } });
  lockedWpId = (await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId, order: 2, title: "Grow", goal: "old goal", status: "locked" } })).id;
});

describe("decideRouteRevision — approve", () => {
  it("applies the goal, flips the revision, and records an honest was/now/why node + refreshes the mirror", async () => {
    // Seed the plan mirror first so the waypoint mirror node exists (body === the old goal).
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, new Date());
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "because HN evidence" });
    const revisionId = res!.revisionId;

    const now = new Date();
    const out = await decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "approved" }, now);
    expect(out).toEqual({ applied: true });

    // Waypoint goal applied.
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("new goal");

    // Revision flipped to approved + decidedAt set.
    const rev = await prisma.routeRevision.findUnique({ where: { id: revisionId } });
    expect(rev?.status).toBe("approved");
    expect(rev?.decidedAt).toBeInstanceOf(Date);

    // The revision MemoryNode records was → now → why (honest correction).
    const revNode = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "revision", sourceId: revisionId } });
    expect(revNode).not.toBeNull();
    expect(revNode?.waypointId).toBe(lockedWpId);
    expect(revNode?.body).toContain("Goal was: old goal");
    expect(revNode?.body).toContain("now: new goal");
    expect(revNode?.body).toContain("because HN evidence");

    // The waypoint MIRROR node body is refreshed to the new goal — recall must not cite the stale goal.
    const mirror = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "waypoint", sourceId: lockedWpId } });
    expect(mirror?.body).toBe("new goal");

    // A `references` edge wires the revision node → the waypoint mirror node.
    const edge = await prisma.memoryEdge.findFirst({ where: { businessId: BIZ, fromId: revNode!.id, toId: mirror!.id, kind: "references" } });
    expect(edge).not.toBeNull();
  });
});

describe("decideRouteRevision — reject", () => {
  it("leaves the waypoint goal byte-unchanged, marks rejected+decidedAt, writes NO revision node", async () => {
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "r" });
    const revisionId = res!.revisionId;

    const out = await decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "rejected" }, new Date());
    expect(out).toEqual({ applied: false });

    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("old goal");
    const rev = await prisma.routeRevision.findUnique({ where: { id: revisionId } });
    expect(rev?.status).toBe("rejected");
    expect(rev?.decidedAt).toBeInstanceOf(Date);
    expect(await prisma.memoryNode.count({ where: { businessId: BIZ, type: "revision" } })).toBe(0);
  });
});

describe("decideRouteRevision — guarded apply", () => {
  it("throws when the waypoint is no longer locked; the revision stays proposed and the goal is unchanged", async () => {
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "r" });
    const revisionId = res!.revisionId;

    // The waypoint advances out of `locked` before the founder decides (a raced apply).
    await prisma.routeWaypoint.update({ where: { id: lockedWpId }, data: { status: "active" } });

    await expect(decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "approved" }, new Date()))
      .rejects.toThrow(/no longer revisable/i);

    // The revision STAYS proposed (the founder sees the failure honestly, can reject); goal unchanged.
    expect((await prisma.routeRevision.findUnique({ where: { id: revisionId } }))?.status).toBe("proposed");
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("old goal");
  });
});

describe("decideRouteRevision — scope + idempotency", () => {
  it("refuses a cross-tenant decide and a double-decide, mutating nothing before the throw", async () => {
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "r" });
    const revisionId = res!.revisionId;

    // Cross-tenant: a foreign business cannot decide this revision; nothing changes.
    await expect(decideRouteRevision({ businessId: OTHER }, { revisionId, decision: "approved" }, new Date()))
      .rejects.toThrow(/not found/i);
    expect((await prisma.routeRevision.findUnique({ where: { id: revisionId } }))?.status).toBe("proposed");
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("old goal");

    // The owner approves once...
    expect(await decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "approved" }, new Date())).toEqual({ applied: true });
    // ...and a second decide on the now-approved revision throws (already decided).
    await expect(decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "approved" }, new Date()))
      .rejects.toThrow(/not found/i);
  });
});

describe("decideRouteRevision — graph-failure resilience", () => {
  it("applies + approves even when the memory graph is gone (graph writes are best-effort, never fatal)", async () => {
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, new Date());
    const res = await proposeRouteRevision({ businessId: BIZ }, { routeId, waypointId: lockedWpId, proposedGoal: "new goal", rationale: "r" });
    const revisionId = res!.revisionId;

    // Wipe the business's memory graph out from under the decide — the RouteRevision row is the durable record.
    await prisma.memoryEdge.deleteMany({ where: { businessId: BIZ } });
    await prisma.memoryNode.deleteMany({ where: { businessId: BIZ } });

    const out = await decideRouteRevision({ businessId: BIZ }, { revisionId, decision: "approved" }, new Date());
    expect(out).toEqual({ applied: true }); // no throw escaped the best-effort graph block
    expect((await prisma.routeWaypoint.findUnique({ where: { id: lockedWpId } }))?.goal).toBe("new goal");
    expect((await prisma.routeRevision.findUnique({ where: { id: revisionId } }))?.status).toBe("approved");
  });
});
