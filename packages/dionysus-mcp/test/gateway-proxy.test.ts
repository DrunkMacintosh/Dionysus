import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, recordOrReport, type GatewayConfig } from "../src/gateway/proxy.js";
import { prisma } from "../src/db.js";

const IDENTITY = { businessId: "biz_proxy" };
let upstream: http.Server;
let gateway: http.Server;
let upstreamHits = 0;
let lastUpstreamAuth: string | undefined;
let gwUrl: string;

beforeAll(async () => {
  await prisma.llmCall.deleteMany({ where: { businessId: "biz_proxy" } });
  await prisma.business.upsert({
    where: { id: "biz_proxy" },
    create: { id: "biz_proxy", name: "Proxy Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 },
  });

  upstream = http.createServer((req, res) => {
    upstreamHits++;
    lastUpstreamAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const cfg: GatewayConfig = {
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    upstreamKey: "sk-upstream-secret",
    inboundToken: "local-token",
  };
  gateway = http.createServer(createGatewayHandler(IDENTITY, cfg));
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gateway.close();
});

function post(path: string, body: unknown, token?: string) {
  return request(`${gwUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("gateway proxy (non-streaming)", () => {
  it("forwards a completion, returns the upstream body, and records real usage", async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    }, "local-token");
    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as { choices: unknown[] };
    expect(body.choices).toHaveLength(1);

    const rows = await prisma.llmCall.findMany({ where: { businessId: "biz_proxy" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(100);
    expect(rows[0]!.outputTokens).toBe(50);
    expect(rows[0]!.costUsd).not.toBeNull(); // claude-haiku-4-5 is priced
    expect(rows[0]!.note).toBe("gateway");
  });

  it("never forwards the caller's Authorization — replaces it with the upstream key", () => {
    expect(lastUpstreamAuth).toBe("Bearer sk-upstream-secret");
  });

  it("records costUsd null for unknown models (no fabricated numbers)", async () => {
    await post("/v1/chat/completions", { model: "mystery-9000", messages: [] }, "local-token");
    const row = await prisma.llmCall.findFirst({
      where: { businessId: "biz_proxy", model: "mystery-9000" },
    });
    expect(row?.costUsd).toBeNull();
  });

  it("rejects a missing/wrong inbound token with 401 and does not contact upstream", async () => {
    const before = upstreamHits;
    const res = await post("/v1/chat/completions", { model: "m", messages: [] }, "wrong");
    expect(res.statusCode).toBe(401);
    await res.body.dump();
    expect(upstreamHits).toBe(before);
  });

  it("404s unknown paths and 400s malformed JSON", async () => {
    const notFound = await post("/v1/other", {}, "local-token");
    expect(notFound.statusCode).toBe(404);
    await notFound.body.dump();

    const bad = await request(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-token" },
      body: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    await bad.body.dump();
  });

  it("blocks over-cap requests with the structured 429 BEFORE contacting upstream", async () => {
    await prisma.business.update({ where: { id: "biz_proxy" }, data: { maxTokensPerDay: 1 } });
    const before = upstreamHits;
    const res = await post("/v1/chat/completions", { model: "claude-haiku-4-5", messages: [] }, "local-token");
    expect(res.statusCode).toBe(429);
    const body = (await res.body.json()) as { error: { type: string } };
    expect(body.error.type).toBe("budget_exhausted");
    expect(upstreamHits).toBe(before);
    await prisma.business.update({ where: { id: "biz_proxy" }, data: { maxTokensPerDay: 100000 } });
  });
});

describe("recordOrReport (metering observability)", () => {
  it("reports recorded:false and logs a structured line when the write fails", async () => {
    const boom = async () => { throw new Error("db down"); };
    const errs: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => { errs.push(String(msg)); };
    try {
      const r = await recordOrReport({ businessId: "biz_x" }, "m", { inputTokens: 1, outputTokens: 2, usageMissing: false }, boom as never);
      expect(r.recorded).toBe(false);
      expect(errs.some((l) => l.includes("gateway:ledger_write_failed") && l.includes("biz_x"))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});
