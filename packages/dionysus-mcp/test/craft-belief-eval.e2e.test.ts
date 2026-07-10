import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { deriveCraftBeliefs, listCraftBeliefs } from "../src/tools/belief-graph.js";
import { mirrorPlanToGraph, buildAgentContext } from "../src/tools/memory-graph.js";
import { createObjective, persistRoute, persistWaypoint } from "../src/tools/plan.js";
import { TOOL_SCHEMAS } from "../src/server.js"; // the 11-tool whitelist source used by every prior gate

// Namespaced tenants so this gate never collides with the other e2e suites sharing the test DB.
const BIZ = "biz_crafteval_a";
const GHOST = "biz_crafteval_b";
const NOW = new Date("2026-07-11T00:00:00.000Z");

async function reset() {
  for (const id of [BIZ, GHOST]) {
    await prisma.memoryEdge.deleteMany({ where: { businessId: id } });
    await prisma.memoryNode.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
}

// Objective/Route/Waypoint via the REAL plan tools; actions raw so the acceptance signal is exact.
async function seedRoute(businessId: string, actions: Array<{ role: string; features: object; status: string; editDistance: number | null }>) {
  const id = { businessId };
  const { objectiveId } = await createObjective(id, { kind: "growth", target: "100 signups", metric: "signups" });
  const { routeId } = await persistRoute(id, { objectiveId, source: "composed" });
  const { waypointId } = await persistWaypoint(id, { routeId, order: 1, title: "W1", goal: "ship" });
  for (const a of actions) {
    await prisma.routeAction.create({ data: { businessId, waypointId, employeeRole: a.role, type: "post", status: a.status, featuresJson: JSON.stringify(a.features), editDistance: a.editDistance } });
  }
  await mirrorPlanToGraph(id, routeId, NOW);
  return { routeId, waypointId };
}

describe("craft-belief eval gate (§15)", () => {
  beforeEach(reset);

  it("inv1 — belief polarity tracks the REAL acceptance signal (mutation-provable): accept→positive, reject→negative", async () => {
    const accepted = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "executed", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: accepted.routeId }, NOW);
    expect((await listCraftBeliefs({ businessId: BIZ }, { role: "copywriter" }))[0]?.stance).toBe("positive");

    const rejected = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
    ]);
    const after = await deriveCraftBeliefs({ businessId: BIZ }, { routeId: rejected.routeId }, NOW);
    expect(after.supersededCount).toBe(1);
    expect((await listCraftBeliefs({ businessId: BIZ }, { role: "copywriter" }))[0]?.stance).toBe("negative");
  });

  it("inv2 — thin evidence is labeled low-confidence and carries NO fabricated metric", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const beliefs = await listCraftBeliefs({ businessId: BIZ });
    expect(beliefs[0]?.confidence).toBeLessThan(0.5);
    expect(beliefs[0]?.body.toLowerCase()).toContain("still learning");
    expect(beliefs[0]?.body).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });

  it("inv3 — beliefs link to REAL action nodes via informed-by (no free-floating assertion)", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    const { beliefNodeIds } = await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const edges = await prisma.memoryEdge.findMany({ where: { businessId: BIZ, fromId: beliefNodeIds[0]!, kind: "informed-by" } });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    for (const e of edges) {
      const target = await prisma.memoryNode.findUnique({ where: { id: e.toId } });
      expect(target?.type).toBe("action");
    }
  });

  it("inv4 — recall renders live beliefs as LABELED hypotheses, excludes superseded, never a metric", async () => {
    const a = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: a.routeId }, NOW);
    const b = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
      { role: "copywriter", features: { channel: "linkedin" }, status: "rejected", editDistance: null },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId: b.routeId }, NOW);

    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId: b.routeId, waypointId: b.waypointId, role: "copywriter" });
    expect(ctx.learnings).toHaveLength(1); // only the live (negative) belief, not the superseded positive
    expect(ctx.learnings[0]?.body.toLowerCase()).toContain("reject");
    expect(ctx.text.toLowerCase()).toContain("learned");
    expect(ctx.text).not.toMatch(/%|percent|conversion|engagement|impressions|clicks|reach/i);
  });

  it("inv5 — businessId-scoped: a ghost tenant with its own belief never leaks into recall", async () => {
    const ghost = await seedRoute(GHOST, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: GHOST }, { routeId: ghost.routeId }, NOW);
    const mine = await seedRoute(BIZ, []);
    const ctx = await buildAgentContext({ businessId: BIZ }, { routeId: mine.routeId, waypointId: mine.waypointId, role: "copywriter" });
    expect(ctx.learnings).toEqual([]);
    expect(await listCraftBeliefs({ businessId: BIZ })).toEqual([]);
    expect((await listCraftBeliefs({ businessId: GHOST })).length).toBeGreaterThan(0); // ghost's belief EXISTS — proves the scope filter is load-bearing
  });

  it("inv6 — the belief layer is NOT MCP: whitelist stays exactly 11, no belief/context tool", () => {
    // Same source + shape as agent-context-eval.e2e.test.ts inv7 (Object.keys(TOOL_SCHEMAS)).
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    expect(toolNames).not.toContain("build_agent_context");
    expect(toolNames).not.toContain("persist_learning");
    expect(toolNames).not.toContain("persist_craft_belief");
    expect(toolNames).not.toContain("derive_craft_beliefs");
  });

  it("inv7 — idempotent: re-derive on unchanged evidence adds ZERO learning rows AND ZERO duplicate informed-by edges", async () => {
    const { routeId } = await seedRoute(BIZ, [
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
      { role: "copywriter", features: { channel: "linkedin" }, status: "approved", editDistance: 0 },
    ]);
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const nodes1 = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    const edges1 = await prisma.memoryEdge.count({ where: { businessId: BIZ, kind: "informed-by" } });
    await deriveCraftBeliefs({ businessId: BIZ }, { routeId }, NOW);
    const nodes2 = await prisma.memoryNode.count({ where: { businessId: BIZ, type: "learning" } });
    const edges2 = await prisma.memoryEdge.count({ where: { businessId: BIZ, kind: "informed-by" } });
    expect(edges1).toBeGreaterThanOrEqual(3); // 3 accepted actions → >=3 informed-by edges (edges EXIST to be duplicated → non-vacuous)
    expect(nodes2).toBe(nodes1);
    expect(edges2).toBe(edges1);
  });
});
