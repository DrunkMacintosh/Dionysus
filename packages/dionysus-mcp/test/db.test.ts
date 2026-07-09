import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

describe("schema", () => {
  beforeAll(async () => {
    await prisma.llmCall.deleteMany({ where: { businessId: "biz_test" } });
    await prisma.business.deleteMany({ where: { id: "biz_test" } });
  });

  it("creates a business with a default daily token cap", async () => {
    const b = await prisma.business.create({
      data: { id: "biz_test", name: "Test Co" },
    });
    expect(b.maxTokensPerDay).toBeGreaterThan(0);
  });

  it("stores an LlmCall with nullable cost", async () => {
    const call = await prisma.llmCall.create({
      data: {
        businessId: "biz_test",
        model: "unknown-model",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
      },
    });
    expect(call.costUsd).toBeNull();
  });
});
