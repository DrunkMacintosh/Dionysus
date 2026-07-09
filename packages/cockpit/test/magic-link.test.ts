import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";

const BIZ = "biz_cockpit_ml";

describe("magic links (H3)", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "MLC" }, update: {} });
  });

  it("issues and redeems once; the raw token is never stored", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const stored = await prisma.magicLink.findMany({ where: { businessId: BIZ } });
    expect(stored.some((l) => l.tokenHash === token)).toBe(false); // hash only
    const redeemed = await verifyMagicLink(token);
    expect(redeemed).toEqual({ businessId: BIZ, email: "f@example.com" });
  });

  it("a second redemption of the same token is refused (single-use)", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await verifyMagicLink(token);
    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i);
  });

  it("concurrent double-redemption: exactly one wins (atomic)", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const results = await Promise.allSettled([verifyMagicLink(token), verifyMagicLink(token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("an expired link is refused; an unknown token is refused", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await prisma.magicLink.updateMany({ where: { businessId: BIZ, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i);
    await expect(verifyMagicLink("not-a-real-token")).rejects.toThrow(/invalid|expired|used/i);
  });

  it("issuing for a nonexistent business fails closed", async () => {
    await expect(issueMagicLink("biz_ml_ghost", "g@example.com")).rejects.toThrow(/not found/i);
  });
});
