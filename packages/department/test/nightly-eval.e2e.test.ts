// §15 stage-6a eval gate — the NIGHTLY WAKE is (1) RERUN-SAFE (a second night over the
// same signals adds zero duplicates), (2) TRUNCATE-NOT-REJECT (an over-cap night keeps
// its strongest 8, never thrown away), (3) ISOLATED + BUDGET-FAIL-CLOSED (one business's
// exhausted budget makes ZERO model calls for it and never blocks the next business),
// (4) METRICS-HONEST (only real fetched values persist; a degraded fetch fabricates
// nothing), (5) CROSS-TENANT-CLEAN (each row lands under its own business), and
// (6) NON-MCP (the whitelist stays 11 — no nightly/radar/ingest tool).
// Tenants live under biz_nightlyeval_* so this gate never collides with other suites.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, runNightlySweep } from "../src/run-nightly.js";
import { MAX_OBSERVATIONS } from "../src/radar-schemas.js";

const A = { businessId: "biz_nightlyeval_a" };
const B = { businessId: "biz_nightlyeval_b" };

async function wipe(businessId: string) {
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

// Distinct objective targets so a counting harness can attribute calls per business.
async function seedBusiness(businessId: string, name: string, target: string) {
  await wipe(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000, name } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target, metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
}

// N grounded HN signals (ids 0..n-1) + a harness that cites the FIRST `cite` of them.
const signalUrl = (i: number) => `https://news.ycombinator.com/item?id=${i}`;
const hnTransportFor = (n: number): HnTransport => async () => ({ status: 200,
  body: JSON.stringify({ hits: Array.from({ length: n }, (_, i) => ({ title: `S${i}`, objectID: `${i}`, points: 100 })) }) });
const citingHarness = (cite: number, calls?: string[]): Harness => ({
  async runAgent(_def: AgentDef, input: string) {
    calls?.push(input);
    return { finalOutput: JSON.stringify({ observations: Array.from({ length: cite }, (_, i) => ({
      title: `S${i}`, body: `b${i}`, sourceUrl: signalUrl(i), relevance: 8, confidence: 0.6 })) }) };
  },
});

describe("§15 stage-6a eval gate — the nightly wake", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
  beforeEach(async () => { await seedBusiness(A.businessId, "Alpha Co", "A-target"); await seedBusiness(B.businessId, "Beta Co", "B-target"); });

  it("inv1 — RERUN-SAFE: a second night over the same signals adds ZERO observations and ZERO proposals", async () => {
    const deps = { harness: citingHarness(2), models: { brain: "fake" }, hnTransport: hnTransportFor(2) };
    const first = await runNightly(A, deps);
    expect(first.radar.status).toBe("ok");
    const obs1 = await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } });
    const act1 = await prisma.routeAction.count({ where: { businessId: A.businessId } });
    expect(obs1).toBe(2); // the first night really recorded (non-vacuous baseline)

    const second = await runNightly(A, deps);
    expect(second.radar.status).toBe("ok"); // a quiet rerun is still a healthy night
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(obs1);
    expect(await prisma.routeAction.count({ where: { businessId: A.businessId } })).toBe(act1);
  });

  it("inv2 — TRUNCATE-NOT-REJECT: 9 grounded observations persist exactly MAX_OBSERVATIONS (8), the night is never thrown away", async () => {
    const deps = { harness: citingHarness(9), models: { brain: "fake" }, hnTransport: hnTransportFor(9) };
    const res = await runNightly(A, deps);
    expect(res.radar.status).toBe("ok"); // NOT failed — the old .max(8) would have thrown the night away
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(MAX_OBSERVATIONS);
  });

  it("inv3 — ISOLATION + BUDGET FAIL-CLOSED: an exhausted business makes ZERO model calls and never blocks the next", async () => {
    await prisma.business.update({ where: { id: A.businessId }, data: { maxTokensPerDay: 0 } });
    const calls: string[] = [];
    const results = await runNightlySweep({ harness: citingHarness(1, calls), models: { brain: "fake" }, hnTransport: hnTransportFor(1) });
    const a = results.find((r) => r.businessId === A.businessId)!;
    const b = results.find((r) => r.businessId === B.businessId)!;
    expect(a.radar.status).toBe("failed"); // the budget gate refused, caught, reported
    expect(calls.some((c) => c.includes("A-target"))).toBe(false); // ZERO model calls for A (fail-closed BEFORE the model)
    expect(b.radar.status).toBe("ok"); // the sweep continued
    expect(calls.some((c) => c.includes("B-target"))).toBe(true); // B's call really happened
  });

  it("inv4 — METRICS HONESTY: only a real fetched value persists; a degraded night fabricates nothing", async () => {
    await connectIntegration(A, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    const okTransport: MetricTransport = async () => ({ ok: true, status: 200, json: async () => ({ value: 42 }) });
    const failTransport: MetricTransport = async () => { throw new Error("endpoint down"); };
    const quietDeps = { harness: citingHarness(0), models: { brain: "fake" }, hnTransport: hnTransportFor(0) };

    const good = await runNightly(A, { ...quietDeps, metricTransport: okTransport });
    expect(good.metrics.status).toBe("ok");
    const snaps = await prisma.metricSnapshot.findMany({ where: { businessId: A.businessId } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.value).toBe(42); // the REAL fetched value

    const degraded = await runNightly(A, { ...quietDeps, metricTransport: failTransport });
    expect(degraded.metrics.status).toBe("skipped"); // no reading — reported honestly
    expect(await prisma.metricSnapshot.count({ where: { businessId: A.businessId } })).toBe(1); // nothing fabricated
  });

  it("inv5 — CROSS-TENANT: each night's rows land under their OWN business only", async () => {
    // Only B gets signals-with-citations; A's model cites nothing (quiet night for A).
    const deps = { harness: citingHarness(1), models: { brain: "fake" }, hnTransport: hnTransportFor(1) };
    await runNightly(B, deps);
    // B's rows exist (non-vacuous), A stays empty even though the same deps could have written.
    expect(await prisma.memoryNode.count({ where: { businessId: B.businessId, type: "market-observation" } })).toBe(1);
    expect(await prisma.memoryNode.count({ where: { businessId: A.businessId, type: "market-observation" } })).toBe(0);
    expect(await prisma.routeAction.count({ where: { businessId: A.businessId } })).toBe(0);
  });

  it("inv6 — NON-MCP: the whitelist stays exactly 11 with no nightly/radar/ingest tool", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    for (const forbidden of ["run_nightly", "run_radar", "ingest_metrics", "connect_integration"]) {
      expect(toolNames).not.toContain(forbidden);
    }
  });
});
