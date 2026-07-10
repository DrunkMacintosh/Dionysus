import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";
import { createSessionToken, verifySessionToken } from "../src/lib/session";
import { redeemLoginCore } from "../src/lib/redeem";

const BIZ = "biz_redeem";
const SECRET = "test-secret";

beforeAll(async () => {
  await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "RD" }, update: {} });
  delete process.env.COCKPIT_BASE_URL;
});

describe("redeemLoginCore (POST-only redemption)", () => {
  it("redeems a valid token into a verifiable session bound to the link's business", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const res = await redeemLoginCore(token, { secret: SECRET });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const session = verifySessionToken(res.sessionToken, SECRET);
      expect(session?.businessId).toBe(BIZ);
      expect(session?.email).toBe("f@example.com");
    }
    const replay = await redeemLoginCore(token, { secret: SECRET });
    expect(replay.ok).toBe(false); // single-use survives the rewrite
  });

  it("REFUSES over an existing VALID session — and the link is NOT consumed", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const live = createSessionToken({ businessId: "biz_other", email: "victim@example.com", exp: Date.now() + 60_000 }, SECRET);
    const refused = await redeemLoginCore(token, { secret: SECRET, existingCookie: live });
    expect(refused.ok).toBe(false);
    const after = await redeemLoginCore(token, { secret: SECRET }); // no live session now
    expect(after.ok).toBe(true); // token survived the refusal
  });

  it("a stale/invalid existing cookie does NOT block login", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const stale = createSessionToken({ businessId: BIZ, email: "f@example.com", exp: Date.now() - 1 }, SECRET);
    const res = await redeemLoginCore(token, { secret: SECRET, existingCookie: stale });
    expect(res.ok).toBe(true);
  });

  it("host mismatch vs COCKPIT_BASE_URL refuses WITHOUT consuming the token", async () => {
    process.env.COCKPIT_BASE_URL = "http://localhost:3000";
    try {
      const { token } = await issueMagicLink(BIZ, "f@example.com");
      const refused = await redeemLoginCore(token, { secret: SECRET, requestHost: "evil.example" });
      expect(refused.ok).toBe(false);
      const ok = await redeemLoginCore(token, { secret: SECRET, requestHost: "localhost:3000" });
      expect(ok.ok).toBe(true); // not burned by the forged-host attempt
    } finally {
      delete process.env.COCKPIT_BASE_URL;
    }
  });

  it("bad/expired tokens yield the uniform {ok:false}", async () => {
    expect((await redeemLoginCore("bogus", { secret: SECRET })).ok).toBe(false);
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await prisma.magicLink.updateMany({ where: { businessId: BIZ, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeemLoginCore(token, { secret: SECRET })).ok).toBe(false);
  });

  it("the GET page is PURE: rendering the interstitial consumes nothing (structural — the page module never imports verifyMagicLink)", async () => {
    const pageSource = (await import("node:fs/promises")).readFile;
    const src = await pageSource(new URL("../src/app/auth/[token]/page.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("verifyMagicLink");
    expect(src).not.toContain("redeemLoginCore"); // redemption lives only behind the POST action
  });
});
