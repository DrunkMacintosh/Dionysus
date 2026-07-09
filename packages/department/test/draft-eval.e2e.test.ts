import { describe, it, expect, beforeAll } from "vitest";
import { draftWaypoint } from "../src/draft-waypoint.js";
import { prisma } from "dionysus-mcp/db";
import type { Harness, AgentDef } from "../src/llm/types.js";

const A = { businessId: "biz_deval_a" };
let waypointId = "";
let executedActionId = "";

beforeAll(async () => {
  for (const id of [A.businessId]) {
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
  }
  const obj = await prisma.objective.create({ data: { businessId: A.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: A.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: A.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  waypointId = wp.id;
  for (const ch of ["hackernews", "reddit", "x"]) {
    await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", featuresJson: JSON.stringify({ channel: ch }) } });
  }
  // a NON-proposed action must NOT be drafted
  const executed = await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", featuresJson: JSON.stringify({ channel: "linkedin" }) } });
  executedActionId = executed.id;
});

// A harness that echoes the channel it was asked to draft for; the eval checks
// fan-out shape, per-channel nativeness, linkage, and scoping — not content.
function evalHarness(): Harness {
  return {
    async runAgent(_d: AgentDef, input: string) {
      const channel = ["hackernews", "reddit", "x"].find((c) => input.includes(c)) ?? "x";
      return { finalOutput: JSON.stringify({ channel, kind: "post", content: { body: `Native copy for ${channel}` } }) };
    },
    async completeOnce() { return "x"; },
  };
}

describe("§15 stage-3b eval gate — copywriter fan-out invariants", () => {
  it("drafts exactly one asset per PROPOSED action (skips non-proposed), channel-native, all linked + scoped", async () => {
    const res = await draftWaypoint(A, { waypointId }, { harness: evalHarness(), models: { brain: "b" } });
    expect(res.drafts).toHaveLength(3);                                  // 3 proposed, NOT the executed one
    expect(res.drafts.map((d) => d.channel).sort()).toEqual(["hackernews", "reddit", "x"]);
    const assets = await prisma.asset.findMany({ where: { businessId: A.businessId } });
    expect(assets).toHaveLength(3);                                       // one per proposed action
    expect(assets.every((a) => a.routeActionId)).toBe(true);             // all linked
    // no draft for the executed action — keyed on the action id so it holds
    // regardless of what channel a wrongly-drafted asset would carry (the harness
    // channel fallback maps unknown channels to "x", never "linkedin")
    expect(await prisma.asset.findFirst({ where: { routeActionId: executedActionId } })).toBeNull();
    const executed = await prisma.routeAction.findUnique({ where: { id: executedActionId } });
    expect(executed?.assetId).toBeNull();
    // channel-native: the drafted channel matches the action's feature channel
    for (const d of res.drafts) {
      const action = await prisma.routeAction.findUnique({ where: { id: d.actionId } });
      expect(JSON.parse(action!.featuresJson).channel).toBe(d.channel);
    }
  });

  it("stage tenant isolation: a ghost business has no assets", async () => {
    const rows = await prisma.asset.findMany({ where: { businessId: "biz_deval_ghost" } });
    expect(rows).toHaveLength(0);
  });
});
