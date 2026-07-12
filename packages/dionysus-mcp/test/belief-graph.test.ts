import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { persistCraftBelief, deriveCraftBeliefs, listCraftBeliefs } from "../src/tools/belief-graph.js";
import type { CraftBelief } from "../src/lib/belief.js";
import { mirrorPlanToGraph } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint } from "../src/tools/plan.js";

const BIZ = "biz-belief-a";
const OTHER = "biz-belief-b";

// Business needs only { id, name }. Wipe child rows scoped to the two tenants
// (FK order: edges/nodes/actions/waypoints/routes/objectives) then upsert the business.
async function resetBusinesses() {
  for (const id of [BIZ, OTHER]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
}

const positive: CraftBelief = { confidence: 0.7, stance: "positive", lowConfidence: false, summary: "Tends to approve (5 as-is, 0 rejected)." };
const negative: CraftBelief = { confidence: 0.6, stance: "negative", lowConfidence: false, summary: "Tends to reject (0 as-is, 4 rejected)." };

const NOW = new Date("2026-07-11T00:00:00.000Z");

// Objective/Route/Waypoint via the REAL plan tools (correct required-field shapes); actions raw so
// status/editDistance/featuresJson are set precisely for the acceptance evidence.
async function seedRoute(businessId: string, actions: Array<{ role: string; features: object; status: string; editDistance: number | null }>) {
  const id = { businessId };
  const { objectiveId } = await createObjective(id, { kind: "growth", target: "100 signups", metric: "signups" });
  const { routeId } = await persistRoute(id, { objectiveId, source: "composed" });
  const { waypointId } = await persistWaypoint(id, { routeId, order: 1, title: "W1", goal: "ship" });
  for (const a of actions) {
    await prisma.routeAction.create({ data: {
      businessId, waypointId, employeeRole: a.role, type: "post", status: a.status,
      featuresJson: JSON.stringify(a.features), editDistance: a.editDistance } });
  }
  return { routeId, waypointId };
}

describe("persistCraftBelief", () => {
  beforeEach(resetBusinesses);

  it("creates one live learning node keyed by role::featureKey, tainted false", async () => {
    const { beliefNodeId, superseded } = await persistCraftBelief(
      { businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(superseded).toBe(false);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeId } });
    expect(node?.type).toBe("learning");
    expect(node?.role).toBe("copywriter");
    expect(node?.sourceId).toBe("copywriter::channel=linkedin");
    expect(node?.stance).toBe("positive");
    expect(node?.confidence).toBeCloseTo(0.7);
    expect(node?.tainted).toBe(false);
  });

  it("updates the live node in place on corroboration (same stance) — zero new rows", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const stronger: CraftBelief = { ...positive, confidence: 0.85, summary: "Tends to approve (8 as-is, 0 rejected)." };
    const second = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: stronger });

    expect(second.beliefNodeId).toBe(first.beliefNodeId);
    expect(second.superseded).toBe(false);
    const learningNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    expect(learningNodes).toHaveLength(1);
    expect(learningNodes[0]?.confidence).toBeCloseTo(0.85);
    expect(learningNodes[0]?.body).toContain("8 as-is");
  });

  it("snapshots + supersedes when the stance flips positive→negative", async () => {
    const first = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const flipped = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative });

    expect(flipped.beliefNodeId).toBe(first.beliefNodeId);
    expect(flipped.superseded).toBe(true);
    const live = await prisma.memoryNode.findUnique({ where: { id: flipped.beliefNodeId } });
    expect(live?.stance).toBe("negative");

    const snapshot = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "learning", sourceId: "copywriter::channel=linkedin::superseded::0" } });
    expect(snapshot?.stance).toBe("positive");
    const edge = await prisma.memoryEdge.findFirst({ where: { businessId: BIZ, kind: "supersedes", fromId: flipped.beliefNodeId, toId: snapshot?.id } });
    expect(edge).not.toBeNull();
  });

  it("scopes to the caller's business — the same key in another tenant is a separate node", async () => {
    const a = await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    const b = await persistCraftBelief({ businessId: OTHER }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    expect(b.beliefNodeId).not.toBe(a.beliefNodeId);
    const aNodes = await prisma.memoryNode.findMany({ where: { businessId: BIZ, type: "learning" } });
    const bNodes = await prisma.memoryNode.findMany({ where: { businessId: OTHER, type: "learning" } });
    expect(aNodes).toHaveLength(1);
    expect(bNodes).toHaveLength(1);
  });
});

describe("deriveCraftBeliefs", () => {
  beforeEach(resetBusinesses);

  it("forms a positive belief when the founder approves a feature's drafts as-is", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "executed", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: null },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW);
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    expect(beliefNodeIds).toHaveLength(1);
    const node = await prisma.memoryNode.findUnique({ where: { id: beliefNodeIds[0]! } });
    expect(node?.stance).toBe("positive");
    const informedBy = await prisma.memoryEdge.findMany({ where: { businessId: BIZ, fromId: beliefNodeIds[0]!, kind: "informed-by" } });
    expect(informedBy.length).toBeGreaterThanOrEqual(1);
    for (const e of informedBy) {
      const target = await prisma.memoryNode.findUnique({ where: { id: e.toId } });
      expect(target?.type).toBe("action");
    }
  });

  it("flips a belief to negative when the acceptance signal reverses (drives supersede)", async () => {
    const first = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "x" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "x" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "x" }, status: "executed", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, first.routeId, NOW);
    const before = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: first.routeId }, NOW);
    expect((await prisma.memoryNode.findUnique({ where: { id: before.beliefNodeIds[0]! } }))?.stance).toBe("positive");

    const second = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "x" }, status: "rejected", editDistance: null },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, second.routeId, NOW);
    const after = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: second.routeId }, NOW);
    expect(after.supersededCount).toBe(1);
    expect((await prisma.memoryNode.findUnique({ where: { id: after.beliefNodeIds[0]! } }))?.stance).toBe("negative");
  });

  it("is idempotent on unchanged evidence — a second derive adds zero learning rows", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const countAfterFirst = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const countAfterSecond = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("skips actions with no whitelisted feature tags (empty key → no belief)", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { radar: true }, status: "approved", editDistance: 0 },
    ]);
    await mirrorPlanToGraph({ businessId: BIZ }, routeId, NOW);
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    expect(beliefNodeIds).toHaveLength(0);
  });

  it("throws on a cross-tenant routeId before any write", async () => {
    const { routeId } = await seedRoute(OTHER, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await expect(deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW)).rejects.toThrow(/not found/i);
    expect(await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } })).toBe(0);
  });
});

describe("persistCraftBelief flip-path concurrency (6a)", () => {
  beforeEach(resetBusinesses);

  it("a raw duplicate snapshot sourceId violates @@unique (P2002) — the constraint the flip-path catch relies on", async () => {
    await prisma.memoryNode.create({ data: { businessId: BIZ, type: "learning", role: "copywriter", title: "s", body: "s", confidence: 0.5, stance: "positive", sourceId: "copywriter::x::superseded::0", tainted: false } });
    await expect(prisma.memoryNode.create({ data: { businessId: BIZ, type: "learning", role: "copywriter", title: "s2", body: "s2", confidence: 0.5, stance: "positive", sourceId: "copywriter::x::superseded::0", tainted: false } }))
      .rejects.toMatchObject({ code: "P2002" });
  });

  it("two RACING flips of the same key: the loser's duplicate-index snapshot create is swallowed — flip still lands, no duplicate snapshot", async () => {
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    // Fire two flips CONCURRENTLY: both read the live node (positive), both count 0 snapshots,
    // both target ::superseded::0 — under SQLite one wins the create, the loser gets P2002.
    const results = await Promise.allSettled([
      persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative }),
      persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative }),
    ]);
    // NEITHER may reject (the old code let the loser throw P2002 uncaught).
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // The live node flipped; the prior state is snapshotted at most once per computed index.
    const live = await prisma.memoryNode.findFirst({ where: { businessId: BIZ, type: "learning", sourceId: "copywriter::channel=linkedin" } });
    expect(live?.stance).toBe("negative");
    const snapshots = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning", sourceId: { startsWith: "copywriter::channel=linkedin::superseded::" } } });
    expect(snapshots).toBeGreaterThanOrEqual(1);
    expect(snapshots).toBeLessThanOrEqual(2); // 1 when the race collides on index 0; 2 if serialization let the loser see count=1 (both honest snapshots)
  });
});

describe("listCraftBeliefs", () => {
  beforeEach(resetBusinesses);

  it("returns live beliefs ordered by confidence, excluding superseded snapshots", async () => {
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: positive });
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=linkedin", belief: negative }); // flips → snapshot
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=x", belief: { confidence: 0.9, stance: "positive", lowConfidence: false, summary: "strong" } });

    const beliefs = await listCraftBeliefs({ businessId: BIZ });
    expect(beliefs).toHaveLength(2);
    expect(beliefs[0]?.confidence).toBeGreaterThanOrEqual(beliefs[1]?.confidence ?? 0);
    expect(beliefs.some((b) => b.title.includes("superseded"))).toBe(false);
  });
});
