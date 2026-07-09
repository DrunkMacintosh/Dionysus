import { describe, it, expect, beforeAll } from "vitest";
import { computeCostUsd } from "../src/lib/pricing.js";
import { recordCost, checkBudget } from "../src/tools/cost-budget.js";
import { prisma } from "../src/db.js";

describe("computeCostUsd", () => {
  it("prices a known model", () => {
    // claude-haiku-4-5: table says 1.0 in / 5.0 out per MTok
    const cost = computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 5);
  });
  it("returns null for unknown models — never a fabricated number", () => {
    expect(computeCostUsd("mystery-model-9000", 1000, 1000)).toBeNull();
  });
});

describe("cost ledger + budget (fail-closed)", () => {
  beforeAll(async () => {
    await prisma.llmCall.deleteMany({ where: { businessId: "biz_cost" } });
    await prisma.business.upsert({
      where: { id: "biz_cost" },
      create: { id: "biz_cost", name: "Cost Co", maxTokensPerDay: 1000 },
      update: { maxTokensPerDay: 1000 },
    });
  });

  it("records a cost row scoped to the identity", async () => {
    const out = await recordCost(
      { businessId: "biz_cost" },
      { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50 },
    );
    const row = await prisma.llmCall.findUnique({ where: { id: out.llmCallId } });
    expect(row?.businessId).toBe("biz_cost");
    expect(row?.costUsd).not.toBeNull();
  });

  it("allows while under the daily cap, blocks once over it", async () => {
    let b = await checkBudget({ businessId: "biz_cost" });
    expect(b.allowed).toBe(true); // 150 of 1000 used

    await recordCost(
      { businessId: "biz_cost" },
      { model: "claude-haiku-4-5", inputTokens: 800, outputTokens: 100 },
    );
    b = await checkBudget({ businessId: "biz_cost" });
    expect(b.allowed).toBe(false); // 1050 of 1000
    expect(b.tokensUsedToday).toBe(1050);
  });

  it("fails closed for an unknown business", async () => {
    const b = await checkBudget({ businessId: "biz_ghost" });
    expect(b.allowed).toBe(false);
    expect(b.reason).toMatch(/unknown business/i);
  });
});
