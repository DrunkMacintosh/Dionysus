import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, type GatewayConfig } from "../src/gateway/proxy.js";
import { prisma } from "../src/db.js";

const IDENTITY = { businessId: "biz_stream" };
let upstream: http.Server;
let gateway: http.Server;
let gwUrl: string;
let lastUpstreamBody = "";

const SSE_CHUNKS = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo!"}}]}\n\n',
  'data: {"usage":{"prompt_tokens":11,"completion_tokens":4},"choices":[]}\n\n',
  "data: [DONE]\n\n",
];

beforeAll(async () => {
  await prisma.llmCall.deleteMany({ where: { businessId: "biz_stream" } });
  await prisma.business.upsert({
    where: { id: "biz_stream" },
    create: { id: "biz_stream", name: "Stream Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 },
  });

  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of SSE_CHUNKS) res.write(c);
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const cfg: GatewayConfig = { port: 0, upstreamUrl: `http://127.0.0.1:${upPort}` };
  gateway = http.createServer(createGatewayHandler(IDENTITY, cfg));
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gateway.close();
});

describe("gateway streaming", () => {
  it("pipes the full SSE stream to the client and records captured usage", async () => {
    const res = await request(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true, messages: [] }),
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    const text = await res.body.text();
    expect(text).toBe(SSE_CHUNKS.join(""));

    // Response ended => the write already happened (write-before-end ordering).
    const rows = await prisma.llmCall.findMany({ where: { businessId: "biz_stream" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(11);
    expect(rows[0]!.outputTokens).toBe(4);
    expect(rows[0]!.note).toBe("gateway");
  });

  it("injects stream_options.include_usage so the cap never depends on client cooperation", async () => {
    const sent = JSON.parse(lastUpstreamBody) as Record<string, unknown>;
    expect((sent["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(true);
    expect(sent["stream"]).toBe(true);
    expect(sent["model"]).toBe("claude-haiku-4-5");
  });
});
