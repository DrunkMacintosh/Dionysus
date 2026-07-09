import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink } from "../src/lib/magic-link";
import { verifySessionToken } from "../src/lib/session";
import { SESSION_COOKIE } from "../src/lib/auth";
import { GET } from "../src/app/auth/[token]/route";

const BIZ = "biz_cockpit_auth";
process.env.COCKPIT_SESSION_SECRET = "test-secret";

function reqFrom(origin: string, token: string): [Request, { params: Promise<{ token: string }> }] {
  return [new Request(`${origin}/auth/${token}`), { params: Promise.resolve({ token }) }];
}

function req(token: string): [Request, { params: Promise<{ token: string }> }] {
  return reqFrom("http://localhost:3000", token);
}

describe("GET /auth/[token]", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "AC" }, update: {} });
  });

  // Origin-binding (H3) is opt-in via COCKPIT_BASE_URL; keep it unset except where a
  // test opts in, so the base cases exercise dev mode and other files are unaffected.
  beforeEach(() => {
    delete process.env.COCKPIT_BASE_URL;
  });
  afterEach(() => {
    delete process.env.COCKPIT_BASE_URL;
  });

  it("redeems a valid link: sets an httpOnly session cookie bound to the link's business and redirects to /", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const res = await GET(...req(token));
    expect(res.status).toBeGreaterThanOrEqual(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    const value = decodeURIComponent(setCookie.split(`${SESSION_COOKIE}=`)[1]!.split(";")[0]!);
    const session = verifySessionToken(value, "test-secret");
    expect(session?.businessId).toBe(BIZ);
    expect(session?.email).toBe("f@example.com");
  });

  it("a bad token redirects to /login?error=invalid with NO cookie", async () => {
    const res = await GET(...req("bogus-token"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("origin-bound: a forged host is refused WITHOUT consuming the token", async () => {
    process.env.COCKPIT_BASE_URL = "http://localhost:3000";
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    // A host-header trick (request arrives at evil.example) must not burn the link.
    const res = await GET(...reqFrom("http://evil.example", token));
    expect(res.headers.get("location")).toContain("/login?error=invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
    // The token is still redeemable on the correct host — it was never consumed.
    const ok = await GET(...req(token));
    expect(ok.headers.get("location")).toBe("http://localhost:3000/");
    expect(ok.headers.get("set-cookie") ?? "").toContain(`${SESSION_COOKIE}=`);
  });

  it("origin-bound: a matching host proceeds normally", async () => {
    process.env.COCKPIT_BASE_URL = "http://localhost:3000";
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const res = await GET(...req(token));
    expect(res.status).toBeGreaterThanOrEqual(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain("httponly");
  });
});
