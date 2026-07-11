import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { buildCmoReport } from "../src/tools/cmo-report.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration } from "../src/tools/integration.js";

// A FIXED clock. Every window in buildCmoReport is computed from this `now`,
// never from wall-clock, so the fixture backdates createdAt/verifiedAt relative
// to it and the assertions are deterministic.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

const BIZ = "biz_cmo";
const EMPTY = "biz_cmo_empty";
const OTHER = "biz_cmo_other";

async function wipe(businessId: string): Promise<void> {
  // FK-safe order: Asset -> RouteAction -> RouteWaypoint -> Route -> Objective; MemoryNode is independent.
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
}

/** Create an executed+verified action bound to an asset (channel/title). */
async function executedAction(
  businessId: string,
  waypointId: string,
  opts: { channel: string; title: string; verifiedAt: Date; createdAt: Date; editDistance?: number },
): Promise<string> {
  const action = await prisma.routeAction.create({
    data: {
      businessId, waypointId, employeeRole: "copywriter", type: "post",
      status: "executed", verifiedAt: opts.verifiedAt, postedUrl: "https://live.test/" + opts.channel,
      createdAt: opts.createdAt, editDistance: opts.editDistance ?? null,
    },
  });
  const asset = await prisma.asset.create({
    data: {
      businessId, routeActionId: action.id, channel: opts.channel, kind: "post",
      contentJson: JSON.stringify({ title: opts.title, body: "b" }), createdAt: opts.createdAt,
    },
  });
  await prisma.routeAction.update({ where: { id: action.id }, data: { assetId: asset.id } });
  return action.id;
}

describe("buildCmoReport — identity-scoped weekly assembly (§3/D21/D31)", () => {
  beforeAll(async () => {
    await wipe(BIZ);
    await wipe(EMPTY);
    await wipe(OTHER);
    for (const id of [BIZ, EMPTY, OTHER]) {
      await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
    }

    // --- BIZ: a live, unmeasured loop -------------------------------------
    // objective = latest by createdAt; an older one must be ignored.
    await prisma.objective.create({
      data: { businessId: BIZ, kind: "awareness", target: "old", metric: "old-metric", status: "done", createdAt: daysAgo(40) },
    });
    const obj = await prisma.objective.create({
      data: { businessId: BIZ, kind: "growth", target: "500 signups", metric: "signups", status: "active", createdAt: daysAgo(30) },
    });
    // earliest route 35d ago -> weeksActive = floor(35/7) = 5 (>= STALL_WEEKS, >= MIN_WEEKS_TO_JUDGE)
    const route = await prisma.route.create({
      data: { businessId: BIZ, objectiveId: obj.id, source: "case", status: "active", createdAt: daysAgo(35) },
    });
    const wp = await prisma.routeWaypoint.create({
      data: { businessId: BIZ, routeId: route.id, order: 1, title: "wp", goal: "g", status: "active", createdAt: daysAgo(35) },
    });

    // 2 executed IN-WEEK (last 7d), verified 2 and 3 days ago -> whatRan newest-first.
    await executedAction(BIZ, wp.id, { channel: "x", title: "Launch tweet", verifiedAt: daysAgo(2), createdAt: daysAgo(2) });
    await executedAction(BIZ, wp.id, { channel: "linkedin", title: "Founder post", verifiedAt: daysAgo(3), createdAt: daysAgo(3) });
    // 1 executed OUT-OF-WEEK (20d ago) — counts to executedTotal/executedRecent, NOT whatRan;
    // its editDistance (100) is out-of-week and must NOT be counted in churnThisWeek.
    await executedAction(BIZ, wp.id, { channel: "x", title: "Old post", verifiedAt: daysAgo(20), createdAt: daysAgo(20), editDistance: 100 });

    // in-flight: 1 approved + 1 executing (createdAt in-week, editDistance contributes to churn)
    await prisma.routeAction.create({
      data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "approved", createdAt: daysAgo(1), editDistance: 5 },
    });
    await prisma.routeAction.create({
      data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executing", createdAt: daysAgo(1) },
    });

    // proposed WITH asset -> proposedPending; editDistance 3 (in-week -> churn).
    const pending = await prisma.routeAction.create({
      data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", createdAt: daysAgo(1), editDistance: 3 },
    });
    const pendingAsset = await prisma.asset.create({
      data: { businessId: BIZ, routeActionId: pending.id, channel: "x", kind: "post", contentJson: JSON.stringify({ title: "Draft", body: "b" }), createdAt: daysAgo(1) },
    });
    await prisma.routeAction.update({ where: { id: pending.id }, data: { assetId: pendingAsset.id } });
    // proposed WITHOUT asset -> NOT proposedPending (proves the assetId filter).
    await prisma.routeAction.create({
      data: { businessId: BIZ, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", createdAt: daysAgo(1) },
    });

    // radar: 1 observation in-week, 1 old.
    await prisma.memoryNode.create({
      data: { businessId: BIZ, type: "market-observation", title: "rival launched", body: "b", confidence: 0.6, sourceUrl: "https://n.test/1", tainted: true, createdAt: daysAgo(2) },
    });
    await prisma.memoryNode.create({
      data: { businessId: BIZ, type: "market-observation", title: "old news", body: "b", confidence: 0.4, sourceUrl: "https://n.test/2", tainted: true, createdAt: daysAgo(15) },
    });

    // --- OTHER: its own single in-week executed action (cross-tenant isolation) --
    const oObj = await prisma.objective.create({
      data: { businessId: OTHER, kind: "growth", target: "t", metric: "m", status: "active", createdAt: daysAgo(30) },
    });
    const oRoute = await prisma.route.create({
      data: { businessId: OTHER, objectiveId: oObj.id, source: "case", status: "active", createdAt: daysAgo(30) },
    });
    const oWp = await prisma.routeWaypoint.create({
      data: { businessId: OTHER, routeId: oRoute.id, order: 1, title: "wp", goal: "g", status: "active", createdAt: daysAgo(30) },
    });
    await executedAction(OTHER, oWp.id, { channel: "x", title: "Other tweet", verifiedAt: daysAgo(1), createdAt: daysAgo(1) });
  });

  it("assembles the weekly report for a live, unmeasured loop", async () => {
    const report = await buildCmoReport({ businessId: BIZ }, NOW);

    // weekOf = ISO date of (now - 7d), UTC day
    expect(report.weekOf).toBe("2026-06-08");

    // objective = latest by createdAt (the "signups" one, not the older "old-metric")
    expect(report.objective).not.toBeNull();
    expect(report.objective!.metric).toBe("signups");
    expect(report.objective!.kind).toBe("growth");
    expect(report.objective!.target).toBe("500 signups");
    expect(report.objective!.status).toBe("active");

    // whatRan: only the 2 in-week verified sends, newest-first, channel/title populated
    expect(report.whatRan).toHaveLength(2);
    expect(report.whatRan[0]!.channel).toBe("x"); // verified 2d ago -> newest
    expect(report.whatRan[0]!.title).toBe("Launch tweet");
    expect(report.whatRan[1]!.channel).toBe("linkedin"); // verified 3d ago
    expect(report.whatRan[0]!.verifiedAt.getTime()).toBeGreaterThan(report.whatRan[1]!.verifiedAt.getTime());

    expect(report.inFlight).toBe(2); // approved + executing
    expect(report.proposedPending).toBe(1); // proposed WITH asset only
    expect(report.radarNoticed).toHaveLength(1); // only the in-week observation
    expect(report.radarNoticed[0]!.title).toBe("rival launched");

    // churnThisWeek = sum of editDistance over actions created in-week (5 + 3); the
    // 20-day-old action's editDistance (100) is out-of-week and excluded.
    expect(report.churnThisWeek).toBe(8);

    // Honesty (§3/D21): analytics disconnected -> an unmeasured verdict that never claims the metric moved.
    expect(report.analyticsConnected).toBe(false);
    expect(["getting-started", "shipping-unmeasured", "stalled"]).toContain(report.verdict.state);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    // grader is metric-agnostic ("your number") -> phrasing preserved, no fabricated metric move.
    expect(report.verdict.headline.toLowerCase()).toContain("your number");
  });

  it("empty business -> objective null, getting-started, everything zeroed", async () => {
    const report = await buildCmoReport({ businessId: EMPTY }, NOW);
    expect(report.objective).toBeNull();
    expect(report.whatRan).toHaveLength(0);
    expect(report.inFlight).toBe(0);
    expect(report.proposedPending).toBe(0);
    expect(report.radarNoticed).toHaveLength(0);
    expect(report.churnThisWeek).toBe(0);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.state).toBe("getting-started");
    expect(report.verdict.claimsMetricMoved).toBe(false);
  });

  it("cross-tenant: another tenant sees only its own data (scoped by businessId)", async () => {
    const other = await buildCmoReport({ businessId: OTHER }, NOW);
    expect(other.whatRan).toHaveLength(1); // its own single in-week send
    expect(other.whatRan[0]!.title).toBe("Other tweet");

    // BIZ's report is unaffected by OTHER's data.
    const biz = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(biz.whatRan).toHaveLength(2);
    expect(biz.whatRan.map((w) => w.title)).not.toContain("Other tweet");
  });
});

describe("buildCmoReport measured (5d)", () => {
  const M = { businessId: "biz_cmo_measured" };
  const NOW = new Date("2026-07-11T00:00:00.000Z");
  const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000);

  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

  beforeEach(async () => {
    await prisma.metricSnapshot.deleteMany({ where: { businessId: M.businessId } });
    await prisma.integration.deleteMany({ where: { businessId: M.businessId } });
    await prisma.routeAction.deleteMany({ where: { businessId: M.businessId } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: M.businessId } });
    await prisma.route.deleteMany({ where: { businessId: M.businessId } });
    await prisma.objective.deleteMany({ where: { businessId: M.businessId } });
    await prisma.business.upsert({ where: { id: M.businessId }, create: { id: M.businessId, name: M.businessId }, update: {} });
    const obj = await prisma.objective.create({ data: { businessId: M.businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: M.businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: M.businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
    await prisma.routeAction.create({ data: { businessId: M.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(1) } });
  });

  it("stays UNMEASURED (no metric-move claim) when no analytics source is connected", async () => {
    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(report.verdict.state).not.toMatch(/^measured/);
  });

  it("reports MEASURED-WORKING with a REAL positive delta from real snapshots", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x", apiKey: "k" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 130, capturedAt: weeksAgo(0) } });

    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.state).toBe("measured-working");
    expect(report.verdict.claimsMetricMoved).toBe(true);
    expect(report.verdict.headline).toContain("30");
    expect(report.verdict.recommendation.toLowerCase()).toContain("attribution");
  });

  it("reports MEASURED-FLAT when connected but the real delta is not positive", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport(M, NOW);
    expect(report.verdict.state).toBe("measured-flat");
    expect(report.verdict.claimsMetricMoved).toBe(false);
  });

  it("stays unmeasured when connected but only ONE snapshot exists (no delta computable — no fabrication)", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.claimsMetricMoved).toBe(false);
  });

  it("stays UNMEASURED when all snapshots predate the route start (no false 'since work went live')", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(10) } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 200, capturedAt: weeksAgo(8) } });
    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.claimsMetricMoved).toBe(false); // pre-route movement is never claimed as "since work went live"
    expect(report.verdict.state).not.toBe("measured-working");
  });
});
