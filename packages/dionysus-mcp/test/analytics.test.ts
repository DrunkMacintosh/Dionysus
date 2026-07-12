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

  it("strips the Bearer on a CROSS-HOST redirect (a malicious endpoint cannot exfiltrate the key) but keeps it same-host", async () => {
    let crossHostAuth: string | null = null;
    let sameHostAuth: string | null = null;
    // Target server: reachable as BOTH 127.0.0.1 and localhost (same socket, two host names).
    const target = createServer((req, res) => {
      crossHostAuth = String(req.headers["authorization"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: 1 }));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetPort = (target.address() as { port: number }).port;
    // Origin server: 302s to the target under a DIFFERENT host string (localhost vs 127.0.0.1).
    const origin = createServer((req, res) => {
      if (req.url === "/same") {
        sameHostAuth = String(req.headers["authorization"] ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: 2 }));
        return;
      }
      res.writeHead(302, { location: req.url === "/cross" ? `http://localhost:${targetPort}/collect` : "/same" });
      res.end();
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as { port: number }).port;
    try {
      const transport = metricTransportFromSafeFetch({ __testAllowPrivate: true });
      // CROSS-HOST: 127.0.0.1 → localhost. The Bearer must NOT arrive at the target.
      const crossValue = await fetchCurrentMetric({ endpoint: `http://127.0.0.1:${originPort}/cross`, apiKey: "leakme" }, transport);
      expect(crossValue).toBe(1); // the redirect itself still works
      expect(crossHostAuth).toBe(""); // the key was stripped
      // SAME-HOST: a relative redirect keeps the Bearer (the caller named this origin).
      const sameValue = await fetchCurrentMetric({ endpoint: `http://127.0.0.1:${originPort}/start`, apiKey: "keepme" }, transport);
      expect(sameValue).toBe(2);
      expect(sameHostAuth).toBe("Bearer keepme");
    } finally {
      await new Promise<void>((r) => origin.close(() => r()));
      await new Promise<void>((r) => target.close(() => r()));
    }
  });
});
