import { describe, it, expect, beforeAll } from "vitest";
import { gateBudget } from "../src/gateway/budget-gate.js";
import { prisma } from "../src/db.js";
import { recordCost } from "../src/tools/cost-budget.js";

describe("gateBudget", () => {
  beforeAll(async () => {
    await prisma.llmCall.deleteMany({ where: { businessId: "biz_gate" } });
    await prisma.business.upsert({
      where: { id: "biz_gate" },
      create: { id: "biz_gate", name: "Gate Co", maxTokensPerDay: 500 },
      update: { maxTokensPerDay: 500 },
    });
  });

  it("passes while under the cap", async () => {
    const r = await gateBudget({ businessId: "biz_gate" });
    expect(r.ok).toBe(true);
  });

  it("blocks with a structured 429 once over the cap", async () => {
    await recordCost(
      { businessId: "biz_gate" },
      { model: "claude-haiku-4-5", inputTokens: 400, outputTokens: 200 },
    );
    const r = await gateBudget({ businessId: "biz_gate" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.body.error.type).toBe("budget_exhausted");
      expect(r.body.error.tokensUsedToday).toBe(600);
      expect(r.body.error.maxTokensPerDay).toBe(500);
    }
  });

  it("blocks unknown businesses (fail-closed) with 429", async () => {
    const r = await gateBudget({ businessId: "biz_gate_ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.error.type).toBe("budget_exhausted");
  });

  it("fails CLOSED with 503 when the budget check itself errors", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    const errs: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => {
      errs.push(String(msg));
    };
    let r: Awaited<ReturnType<typeof gateBudget>>;
    try {
      r = await gateBudget({ businessId: "biz_gate" }, boom as never);
    } finally {
      console.error = orig;
    }
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.body.error.type).toBe("budget_check_failed");
      // Generic client message — no raw DB internals leaked.
      expect(r.body.error.message).not.toContain("db down");
    }
    // The structured detail is logged server-side instead.
    expect(errs.some((l) => l.includes("gateway:budget_check_error") && l.includes("biz_gate"))).toBe(true);
  });
});
