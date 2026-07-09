import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_maglink";

describe("MagicLink schema", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ },
      create: { id: BIZ, name: "ML Co", ownerEmail: "founder@example.com" },
      update: { ownerEmail: "founder@example.com" } });
  });

  it("persists a link with a unique token hash and null usedAt", async () => {
    const link = await prisma.magicLink.create({ data: {
      businessId: BIZ, email: "founder@example.com",
      tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    expect(link.usedAt).toBeNull();
    await expect(prisma.magicLink.create({ data: {
      businessId: BIZ, email: "founder@example.com",
      tokenHash: "a".repeat(64), expiresAt: new Date() } })).rejects.toThrow(/unique/i);
  });

  it("Business carries ownerEmail", async () => {
    const b = await prisma.business.findUnique({ where: { id: BIZ } });
    expect(b?.ownerEmail).toBe("founder@example.com");
  });
});
