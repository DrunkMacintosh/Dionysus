import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { persistCraftBelief } from "../src/tools/belief-graph.js";
import { analyzeRouteForRevision } from "../src/tools/growth-analyst.js";

// A FIXED clock. buildCmoReport derives every window from this `now`, so backdating
// route/verifiedAt relative to it lands the verdict deterministically.
const NOW = new Date("2026-07-13T00:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const weeksAgo = (n: number): Date => new Date(NOW.getTime() - n * WEEK_MS);

const BIZ = "biz_growth_a";
const GOAL = "old goal";
// A distinctive, METRIC-WORD-FREE token so we can assert the rationale cites the real
// belief body without any /%|percent|conversion|engagement|impressions|clicks|reach/ word.
const BELIEF_BODY = "readers replied warmly on hn HNWINALPHA";
const METRIC_WORDS = /%|percent|conversion|engagement|impressions|clicks|reach/i;

async function wipe(businessId: string): Promise<void> {
  await prisma.routeRevision.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.business.upsert({ where: { id: businessId }, create: { id: businessId, name: businessId }, update: {} });
}

/**
 * A STALLED fixture: route created 6 weeks ago + ONE verified send 5 weeks ago
 * (executedTotal>0 but executedRecent 0 over the 3-week stall window → the grader
 * lands on "stalled"). The next waypoint's status is caller-chosen: `locked` is
 * revisable; `active` gives the analyzer no target.
 */
async function seedStalled(businessId: string, waypointStatus: "locked" | "active"): Promise<{ routeId: string; waypointId: string }> {
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Grow", goal: GOAL, status: waypointStatus, createdAt: weeksAgo(6) } });
  await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(5), createdAt: weeksAgo(5) } });
  return { routeId: route.id, waypointId: wp.id };
}

/** Seed the positive-evidence channel (hackernews) with a distinctive cited body. */
async function seedPositiveHackernews(businessId: string): Promise<void> {
  await persistCraftBelief({ businessId }, {
    role: "copywriter", featureKey: "channel=hackernews",
    belief: { confidence: 0.5, stance: "positive", lowConfidence: false, summary: BELIEF_BODY },
  });
}

describe("analyzeRouteForRevision — the Growth Analyst's deterministic trigger (stage 6c)", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

  beforeEach(async () => { await wipe(BIZ); });
  // Leave the shared test DB as clean as we found it — a sibling suite counts RouteRevision
  // rows globally (unscoped), so this suite must not leak its proposals across files.
  afterAll(async () => { await wipe(BIZ); });

  it("STALLED + positive-evidence channel + locked waypoint → proposes an evidence-cited revision (never-auto)", async () => {
    const { waypointId } = await seedStalled(BIZ, "locked");
    await seedPositiveHackernews(BIZ);

    const res = await analyzeRouteForRevision({ businessId: BIZ }, NOW);
    expect(res).not.toBeNull();

    const row = await prisma.routeRevision.findUnique({ where: { id: res!.revisionId } });
    expect(row?.status).toBe("proposed");
    expect(row?.proposedGoal).toBe("Lead with hackernews — old goal");
    expect(row!.proposedGoal.startsWith("Lead with hackernews — ")).toBe(true);
    // rationale cites BOTH the stalled verdict phrase AND the real belief body...
    expect(row?.rationale).toContain("The plan has stalled");
    expect(row?.rationale).toContain(BELIEF_BODY);
    // ...and never fabricates a metric/% move.
    expect(row!.rationale).not.toMatch(METRIC_WORDS);

    // NEVER-AUTO: the locked waypoint's goal is byte-unchanged — only decide applies it.
    expect((await prisma.routeWaypoint.findUnique({ where: { id: waypointId } }))?.goal).toBe(GOAL);
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(1);
  });

  it("verdict getting-started (fresh business, no sends) → null, writes nothing", async () => {
    // Everything case 1 has (locked waypoint + positive belief) EXCEPT the stalled verdict:
    // a route with no verified send is getting-started → the verdict is the sole discriminator.
    const obj = await prisma.objective.create({ data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: BIZ, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(0) } });
    await prisma.routeWaypoint.create({ data: { businessId: BIZ, routeId: route.id, order: 1, title: "Grow", goal: GOAL, status: "locked", createdAt: weeksAgo(0) } });
    await seedPositiveHackernews(BIZ);

    expect(await analyzeRouteForRevision({ businessId: BIZ }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("STALLED but NO positive-evidence channel (no beliefs) → null, writes nothing", async () => {
    await seedStalled(BIZ, "locked"); // stalled + locked, but no beliefs → cited is empty

    expect(await analyzeRouteForRevision({ businessId: BIZ }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("STALLED with evidence but NO locked waypoint (single active waypoint) → null, writes nothing", async () => {
    await seedStalled(BIZ, "active"); // stalled + positive evidence, but no revisable target
    await seedPositiveHackernews(BIZ);

    expect(await analyzeRouteForRevision({ businessId: BIZ }, NOW)).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("ONE-STANDING: a second analyze after the first proposes → null, count stays 1", async () => {
    await seedStalled(BIZ, "locked");
    await seedPositiveHackernews(BIZ);

    const first = await analyzeRouteForRevision({ businessId: BIZ }, NOW);
    expect(first).not.toBeNull();
    const second = await analyzeRouteForRevision({ businessId: BIZ }, NOW);
    expect(second).toBeNull();
    expect(await prisma.routeRevision.count({ where: { businessId: BIZ } })).toBe(1);
  });
});
