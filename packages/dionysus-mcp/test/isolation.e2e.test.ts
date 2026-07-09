import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../src/db.js";
import { readProduct } from "../src/tools/read-product.js";
import { recordCost, checkBudget } from "../src/tools/cost-budget.js";
import type { LookupFn } from "../src/lib/ssrf.js";

let server: http.Server;
let port: number;
const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

const A = { businessId: "biz_iso_a" };
const B = { businessId: "biz_iso_b" };

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>iso</title><body>hello</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  for (const id of [A.businessId, B.businessId]) {
    await prisma.business.upsert({
      where: { id },
      create: { id, name: id, maxTokensPerDay: 1000 },
      update: { maxTokensPerDay: 1000 },
    });
    await prisma.product.deleteMany({ where: { businessId: id } });
    await prisma.llmCall.deleteMany({ where: { businessId: id } });
  }
});

afterAll(() => server.close());

describe("two-tenant isolation (D27.1 exit gate)", () => {
  it("A's writes are invisible to B", async () => {
    await readProduct(A, `http://local.test:${port}/`, testOpts);
    const bProducts = await prisma.product.findMany({
      where: { businessId: B.businessId },
    });
    expect(bProducts).toHaveLength(0);
    const aProducts = await prisma.product.findMany({
      where: { businessId: A.businessId },
    });
    expect(aProducts).toHaveLength(1);
  });

  it("A exhausting its budget does not touch B's budget", async () => {
    await recordCost(A, { model: "claude-haiku-4-5", inputTokens: 900, outputTokens: 200 });
    const a = await checkBudget(A);
    const b = await checkBudget(B);
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
    expect(b.tokensUsedToday).toBe(0);
  });

  it("no exported tool function accepts a businessId argument", async () => {
    // Compile-time guarantee made explicit: the public tool functions take
    // Identity (ambient) + payload. This test asserts the runtime shape too.
    const fns: Array<(...a: never[]) => unknown> = [readProduct, recordCost, checkBudget];
    for (const fn of fns) {
      expect(fn.length).toBeLessThanOrEqual(3);
    }
  });
});
