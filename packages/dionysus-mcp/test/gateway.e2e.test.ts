import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, type GatewayConfig } from "../src/gateway/proxy.js";
import { checkBudget } from "../src/tools/cost-budget.js";
import { prisma } from "../src/db.js";

const A = { businessId: "biz_gwe_a" };
let upstream: http.Server;
let gatewayA: http.Server;
let hits = 0;
let urlA: string;

beforeAll(async () => {
  for (const id of ["biz_gwe_a", "biz_gwe_b"]) {
    await prisma.llmCall.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({
      where: { id },
      create: { id, name: id, maxTokensPerDay: 200 },
      update: { maxTokensPerDay: 200 },
    });
  }
  upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 100 } }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;
  const cfg: GatewayConfig = { port: 0, upstreamUrl: `http://127.0.0.1:${upPort}` };
  gatewayA = http.createServer(createGatewayHandler(A, cfg));
  await new Promise<void>((r) => gatewayA.listen(0, "127.0.0.1", r));
  urlA = `http://127.0.0.1:${(gatewayA.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gatewayA.close();
});

async function callA() {
  return request(`${urlA}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
  });
}

describe("D28 exit gate — the loop closes", () => {
  it("first call passes; the recorded usage then trips the hard cap on the second call, upstream untouched", async () => {
    const r1 = await callA();
    expect(r1.statusCode).toBe(200);
    await r1.body.dump();
    expect(hits).toBe(1); // 150+100 = 250 tokens recorded > 200 cap

    const r2 = await callA();
    expect(r2.statusCode).toBe(429);
    const body = (await r2.body.json()) as { error: { type: string } };
    expect(body.error.type).toBe("budget_exhausted");
    expect(hits).toBe(1); // upstream NEVER contacted on the blocked call
  });

  it("the advisory check_budget now reflects gateway-metered spend (no self-reporting)", async () => {
    const b = await checkBudget(A);
    expect(b.allowed).toBe(false);
    expect(b.tokensUsedToday).toBe(250);
  });

  it("gateway writes are scoped to the ambient identity — the other tenant is untouched", async () => {
    const other = await prisma.llmCall.findMany({ where: { businessId: "biz_gwe_b" } });
    expect(other).toHaveLength(0);
    const b = await checkBudget({ businessId: "biz_gwe_b" });
    expect(b.allowed).toBe(true);
    expect(b.tokensUsedToday).toBe(0);
  });
});
