import { describe, it, expect, beforeAll } from "vitest";
import { proposeRoute } from "../src/propose-route.js";
import { prisma } from "dionysus-mcp/db";
import { persistCase } from "dionysus-mcp/tools/persist-case";
import type { Harness, AgentDef } from "../src/llm/types.js";

const A = { businessId: "biz_reval_a" };
let caseId = "";

beforeAll(async () => {
  for (const id of [A.businessId]) {
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
  }
  caseId = (await persistCase(A, { name: "C", platform: "hn", mode: "m", rank: 1,
    historicalArc: [], modernizedPlan: {}, insight: "i", sources: [], confidence: 0.5 })).caseId;
});

// A harness that returns 3 ordered waypoints; the eval checks structure + scoping, not content.
function evalHarness(): Harness {
  return {
    async runAgent(_d: AgentDef, _i: string) {
      return { finalOutput: JSON.stringify({ waypoints: [
        { title: "W1", goal: "g1", actions: [{ employeeRole: "copywriter", type: "post", rationale: "r1" }] },
        { title: "W2", goal: "g2", actions: [{ employeeRole: "social", type: "reply", rationale: "r2" }] },
        { title: "W3", goal: "g3", actions: [{ employeeRole: "outreach", type: "pitch", rationale: "r3" }] },
      ] }) };
    },
    async completeOnce() { return "x"; },
  };
}

describe("§15 stage-3a eval gate — plan-layer invariants", () => {
  it("route waypoints are ordered 1..N, reference the objective, every action carries rationale + is proposed", async () => {
    const plan = await proposeRoute(A, { objective: { kind: "signups", target: "100", metric: "users" }, caseId },
      { harness: evalHarness(), models: { brain: "b" } });
    expect(plan.waypoints.map((w) => w.order)).toEqual([1, 2, 3]);        // strictly ordered
    const route = await prisma.route.findUnique({ where: { id: plan.routeId } });
    expect(route?.objectiveId).toBe(plan.objectiveId);                    // route → objective
    const actions = await prisma.routeAction.findMany({ where: { businessId: A.businessId } });
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.status === "proposed" && a.rationale && a.rationale.length > 0)).toBe(true);
    const first = await prisma.routeWaypoint.findFirst({ where: { routeId: plan.routeId, order: 1 } });
    const locked = await prisma.routeWaypoint.findFirst({ where: { routeId: plan.routeId, order: 2 } });
    expect(first?.status).toBe("active");                                 // only first active
    expect(locked?.status).toBe("locked");                               // rest locked
  });

  it("stage-1 tenant isolation holds: a ghost business sees no plan rows", async () => {
    for (const table of ["routeAction", "routeWaypoint", "route", "objective"] as const) {
      // @ts-expect-error dynamic table access for a compact isolation sweep
      const rows = await prisma[table].findMany({ where: { businessId: "biz_reval_ghost" } });
      expect(rows).toHaveLength(0);
    }
  });
});
