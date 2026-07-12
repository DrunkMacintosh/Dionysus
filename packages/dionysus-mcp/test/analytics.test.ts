import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration } from "../src/tools/integration.js";
import { fetchCurrentMetric, ingestMetrics, metricTransportFromSafeFetch, type MetricTransport } from "../src/tools/analytics.js";

const BIZ = "biz_analytics_a";

beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
beforeEach(async () => {
  await prisma.metricSnapshot.deleteMany({ where: { businessId: BIZ } });
  await prisma.integration.deleteMany({ where: { businessId: BIZ } });
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: BIZ }, update: {} });
});

const okTransport = (value: unknown): MetricTransport => async () => ({ ok: true, status: 200, json: async () => ({ value }) });
const failTransport: MetricTransport = async () => { throw new Error("network down"); };

describe("fetchCurrentMetric", () => {
  it("reads the numeric value at the default path", async () => {
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, okTransport(42))).toBe(42);
  });
  it("degrades to null on a transport throw / non-200 / non-numeric body", async () => {
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, failTransport)).toBeNull();
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, async () => ({ ok: false, status: 500, json: async () => ({}) }))).toBeNull();
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, okTransport("not-a-number"))).toBeNull();
  });
  it("degrades to null when endpoint is missing", async () => {
    expect(await fetchCurrentMetric({}, okTransport(1))).toBeNull();
  });
});

describe("ingestMetrics", () => {
  it("persists ONE real snapshot for the connected analytics source", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x/api", apiKey: "k" } });
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(120) });
    expect(snapshotId).not.toBeNull();
    const snaps = await prisma.metricSnapshot.findMany({ where: { businessId: BIZ } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.value).toBe(120);
    expect(snaps[0]?.metric).toBe("signups");
  });

  it("persists NOTHING when there is no connected source", async () => {
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(1) });
    expect(snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("persists NOTHING when the fetch degrades (honest: no reading → no snapshot)", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x/api" } });
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: failTransport });
    expect(snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
  });
});

describe("metricTransportFromSafeFetch (production transport)", () => {
  it("reads a real JSON metric through the SSRF-guarded fetch (test seam) and forwards the Bearer header", async () => {
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenAuth = String(req.headers["authorization"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: 7 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const transport = metricTransportFromSafeFetch({ __testAllowPrivate: true });
      const value = await fetchCurrentMetric({ endpoint: `http://127.0.0.1:${port}/stats`, apiKey: "k123" }, transport);
      expect(value).toBe(7);
      expect(seenAuth).toBe("Bearer k123");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a private/loopback endpoint WITHOUT the test seam is SSRF-blocked and degrades to null (no reading, no snapshot)", async () => {
    const transport = metricTransportFromSafeFetch(); // production posture
    const value = await fetchCurrentMetric({ endpoint: "http://127.0.0.1/stats" }, transport);
    expect(value).toBeNull(); // the SSRF throw is caught by fetchCurrentMetric's degrade path
  });
});
