import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import { GROWTH_ROLE } from "../src/tools/performance-belief.js";
import { recommendNextAction, EXPLORE_BONUS } from "../src/tools/recommend.js";

const BIZ = "biz_reco_a";
let waypointId = "";

beforeEach(async () => {
  for (const t of ["memoryEdge", "memoryNode", "routeAction", "routeWaypoint", "route", "objective"] as const) {
    // @ts-expect-error dynamic model access in a test helper
    await prisma[t].deleteMany({ where: { businessId: BIZ } });
  }
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: BIZ }, update: {} });
  const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
  waypointId = wp.id;
});

const belief = (stance: "positive" | "negative", confidence: number, summary: string) =>
  ({ confidence, stance, lowConfidence: false, summary });

describe("recommendNextAction", () => {
  it("EXPLOITS: proposes the channel with the strongest positive evidence, rationale citing it — never-auto", async () => {
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=hackernews", belief: belief("positive", 0.5, "approved as-is") });
    await persistCraftBelief({ businessId: BIZ }, { role: GROWTH_ROLE, featureKey: "channel=hackernews", belief: belief("positive", 0.6, "number rose after") });
    await persistCraftBelief({ businessId: BIZ }, { role: GROWTH_ROLE, featureKey: "channel=x", belief: belief("negative", 0.7, "number fell after") });
    // Make "x" a real candidate: a non-proposed action in history carrying channel=x. Otherwise
    // candidates = action-history + DEFAULT_EXPLORE_CHANNELS = ["hackernews"] only, so scoring is
    // never exercised (single candidate). "rejected" keeps it out of the standing-proposal check.
    await prisma.routeAction.create({ data: { businessId: BIZ, waypointId, employeeRole: "copywriter", type: "post", status: "rejected", featuresJson: JSON.stringify({ channel: "x" }) } });

    const rec = await recommendNextAction({ businessId: BIZ });
    expect(rec?.channel).toBe("hackernews"); // 0.5*1 + 0.6*2 = 1.7 beats x's -1.4 and any explore bonus
    const action = await prisma.routeAction.findUnique({ where: { id: rec!.actionId } });
    expect(action?.status).toBe("proposed"); // NEVER-AUTO
    expect(action?.assetId).toBeNull();
    expect(action?.waypointId).toBe(waypointId);
    expect(JSON.parse(action!.featuresJson)).toMatchObject({ channel: "hackernews", recommender: true });
    expect(action?.rationale).toContain("number rose after"); // evidence-cited, explainable
  });

  it("EXPLORES: with no beliefs at all, proposes a default channel with an exploring rationale", async () => {
    const rec = await recommendNextAction({ businessId: BIZ });
    expect(rec?.channel).toBe("hackernews"); // the default explore candidate
    expect(rec?.reason.toLowerCase()).toContain("explor");
    expect(EXPLORE_BONUS).toBeGreaterThan(0);
  });

  it("ONE standing recommendation: a pending undrafted recommender proposal suppresses a new one", async () => {
    const first = await recommendNextAction({ businessId: BIZ });
    expect(first).not.toBeNull();
    const second = await recommendNextAction({ businessId: BIZ });
    expect(second).toBeNull();
    expect(await prisma.routeAction.count({ where: { businessId: BIZ } })).toBe(1); // no pile-up
  });

  it("returns null with no active waypoint (nothing to attach to) — writes nothing", async () => {
    await prisma.routeWaypoint.updateMany({ where: { businessId: BIZ }, data: { status: "done" } });
    expect(await recommendNextAction({ businessId: BIZ })).toBeNull();
    expect(await prisma.routeAction.count({ where: { businessId: BIZ } })).toBe(0);
  });
});
