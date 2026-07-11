import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration, getDecryptedConfig } from "../src/tools/integration.js";
import { ingestMetrics, type MetricTransport } from "../src/tools/analytics.js";
import { buildCmoReport } from "../src/tools/cmo-report.js";
import { TOOL_SCHEMAS } from "../src/server.js";

const BIZ = "biz_measeval_a";
const GHOST = "biz_measeval_b";
const NOW = new Date("2026-07-11T00:00:00.000Z");
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000);
const okTransport = (v: number): MetricTransport => async () => ({ ok: true, status: 200, json: async () => ({ value: v }) });

beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

async function seedShippedBusiness(businessId: string) {
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.business.upsert({ where: { id: businessId }, create: { id: businessId, name: businessId }, update: {} });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
  await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(1) } });
}

describe("measurement eval gate (§15)", () => {
  beforeEach(() => seedShippedBusiness(BIZ));

  it("inv1 — an UNCONNECTED business never claims a metric moved (claimsMetricMoved false, unmeasured state)", async () => {
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(report.verdict.state).not.toMatch(/^measured/);
  });

  it("inv2 — measured-working requires BOTH a real connection AND a real positive delta (the honesty invariant end-to-end)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    let report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.claimsMetricMoved).toBe(false); // connected but ZERO snapshots → still no claim
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 125, capturedAt: weeksAgo(0) } });
    report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.verdict.state).toBe("measured-working");
    expect(report.verdict.claimsMetricMoved).toBe(true);
    expect(report.verdict.headline).toContain("25");
  });

  it("inv3 — the delta is REAL: it tracks the snapshot data (not a constant / fabricated)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 200, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 300, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.verdict.headline).toContain("50"); // (300-200)/200 = 50%, tracks the real rows
  });

  it("inv4 — config is encrypted at rest: the DB column never holds the plaintext key, but it round-trips", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x", apiKey: "TOP-SECRET-KEY" } });
    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect(row?.configEnc).not.toContain("TOP-SECRET-KEY");
    expect(await getDecryptedConfig({ businessId: BIZ }, integrationId)).toMatchObject({ apiKey: "TOP-SECRET-KEY" });
  });

  it("inv5 — ingestMetrics persists ONLY real fetched values; a degraded fetch fabricates nothing; a real 0 IS a real reading", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    const failTransport: MetricTransport = async () => { throw new Error("down"); };
    const degraded = await ingestMetrics({ businessId: BIZ }, { transport: failTransport });
    expect(degraded.snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
    // A real fetched 0 is a real reading and MUST persist (guards against a `if (!value)` regression).
    const zero = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(0) });
    expect(zero.snapshotId).not.toBeNull();
    const real = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(77) });
    expect(real.snapshotId).not.toBeNull();
    const snaps = await prisma.metricSnapshot.findMany({ where: { businessId: BIZ }, orderBy: { value: "asc" } });
    expect(snaps.map((s) => s.value)).toEqual([0, 77]);
  });

  it("inv6 — scoped: a ghost tenant's connection + snapshots never affect this business's report", async () => {
    await seedShippedBusiness(GHOST);
    const { integrationId } = await connectIntegration({ businessId: GHOST }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: GHOST, integrationId, metric: "signups", value: 1, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: GHOST, integrationId, metric: "signups", value: 999, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    const ghostReport = await buildCmoReport({ businessId: GHOST }, NOW);
    expect(ghostReport.verdict.state).toBe("measured-working"); // ghost genuinely measures — proves the scope filter is load-bearing
  });

  it("inv7 — measurement is NOT MCP: whitelist stays exactly 11, no integration/analytics tool", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    for (const forbidden of ["connect_integration", "ingest_metrics", "record_metric", "disconnect_integration"]) {
      expect(toolNames).not.toContain(forbidden);
    }
  });
});
