import { NextResponse } from "next/server";
import { verifyMagicLink } from "../../../lib/magic-link";
import { createSessionToken } from "../../../lib/session";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionSecret } from "../../../lib/auth";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;

  // H3 origin-binding: when a canonical base URL is configured, only redeem for a
  // request whose host matches it. This runs BEFORE verifyMagicLink so a forged Host
  // header cannot burn the founder's single-use link (no token consumption on mismatch).
  // Redirect against the trusted base — never echo the attacker-controlled host back.
  const baseUrl = process.env.COCKPIT_BASE_URL;
  if (baseUrl && new URL(req.url).host !== new URL(baseUrl).host) {
    return NextResponse.redirect(new URL("/login?error=invalid", baseUrl));
  }

  try {
    const { businessId, email } = await verifyMagicLink(token);
    const session = createSessionToken(
      { businessId, email, exp: Date.now() + SESSION_TTL_MS },
      sessionSecret(),
    );
    const res = NextResponse.redirect(new URL("/", req.url));
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return res;
  } catch {
    // Uniform error surface: never reveal WHY (invalid / expired / used / origin).
    return NextResponse.redirect(new URL("/login?error=invalid", req.url));
  }
}
