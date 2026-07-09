import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { discover } from "../src/discover.js";
import { prisma } from "dionysus-mcp/db";
import type { Harness, AgentDef } from "../src/llm/types.js";

const IDENTITY = { businessId: "biz_disc" };
let fixture: http.Server; let base = "";
const seams = { lookupFn: async () => [{ address: "127.0.0.1", family: 4 }], __testAllowPrivate: true } as never;

beforeAll(async () => {
  fixture = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/product") res.end("<html><title>Acme CLI</title><body>A CLI for devs.</body></html>");
    else if (req.url === "/source-good") res.end("<html><body>Zed launched on Hacker News in 2023 to great fanfare.</body></html>");
    else res.end("<html><body>gardening tips only</body></html>"); // the poisoned source
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  base = `http://local.test:${(fixture.address() as { port: number }).port}`;
  await prisma.case.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.llmCall.deleteMany({ where: { businessId: IDENTITY.businessId } });
  await prisma.business.upsert({ where: { id: IDENTITY.businessId },
    create: { id: IDENTITY.businessId, name: "Disc Co", maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
});
afterAll(() => fixture.close());

function fakeHarness(): Harness {
  return {
    async runAgent(def: AgentDef, _input: string) {
      if (def.name === "historian") return { finalOutput: JSON.stringify({ cases: [{
        name: "Zed", platform: "hackernews", mode: "launch-led", rank: 1,
        claims: [
          { text: "Zed launched on HN in 2023", kind: "EXTRACTED", sourceUrl: `${base}/source-good` },
          { text: "Zed grew via gardening blogs", kind: "EXTRACTED", sourceUrl: `${base}/source-poison` },
          { text: "Dev-tool audiences reward authenticity", kind: "INFERRED" },
        ]}]})};
      return { finalOutput: JSON.stringify({ historicalArc: [{ when: "2023", beat: "HN launch" }],
        modernizedPlan: { steps: ["Show HN"] }, insight: "Authenticity wins.", confidence: 0.7 }) };
    },
    async completeOnce(_m: string, _s: string, user: string) {
      return user.includes("Hacker News") ? "YES" : "NO"; // judge sees fenced source text
    },
  };
}

describe("discover pipeline (D34, faked models)", () => {
  it("runs end-to-end: sources verified, poisoned citation downgraded, cases persisted + scoped", async () => {
    const brief = await discover(IDENTITY, `${base}/product`, {
      harness: fakeHarness(), models: { brain: "fake-brain", judge: "fake-judge" }, fetchOpts: seams,
    });
    expect(brief.cases).toHaveLength(1);
    const claims = brief.cases[0]!.claims;
    expect(claims.find((c) => c.text.includes("HN in 2023"))!.kind).toBe("EXTRACTED");
    expect(claims.find((c) => c.text.includes("gardening"))!.kind).toBe("INFERRED"); // poisoned → downgraded
    const rows = await prisma.case.findMany({ where: { businessId: IDENTITY.businessId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confidence).toBeLessThanOrEqual(0.7);
  });

  it("fails closed when the budget is exhausted", async () => {
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 0 } });
    await expect(discover(IDENTITY, `${base}/product`, {
      harness: fakeHarness(), models: { brain: "b", judge: "j" }, fetchOpts: seams,
    })).rejects.toThrow(/budget/i);
    await prisma.business.update({ where: { id: IDENTITY.businessId }, data: { maxTokensPerDay: 100000 } });
  });
});
