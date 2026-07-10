import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySessionToken, type SessionPayload } from "./session";

export const SESSION_COOKIE = "dionysus_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

// Session-cookie hardening: the security-critical flags live here as a tested pure
// function, not inline in the server action. The literal `true`/`"lax"` return types
// are load-bearing — they make a future `httpOnly: false` (or a flipped sameSite) a
// COMPILE error, closing the XSS session-theft regression surface that `next build`
// alone would miss (all cookie options are optional in the type).
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

// Fail-closed: a missing secret throws rather than falling back to a default,
// so an unconfigured deploy cannot mint or accept forgeable sessions.
export function sessionSecret(): string {
  const secret = process.env.COCKPIT_SESSION_SECRET;
  if (!secret) throw new Error("COCKPIT_SESSION_SECRET is not configured.");
  return secret;
}

// Thin request-scope guard: reads the signed cookie and redirects unauthenticated
// callers to /login. Exercised via Task 5's pages + `next build` (needs next/headers
// + next/navigation, which only resolve inside a request scope).
export async function requireSession(): Promise<SessionPayload> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = token ? verifySessionToken(token, sessionSecret()) : null;
  if (!session) redirect("/login");
  return session;
}
