"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { redeemLoginCore } from "../lib/redeem";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionSecret } from "../lib/auth";

export async function redeemLogin(formData: FormData): Promise<void> {
  const secret = sessionSecret(); // fail-closed BEFORE anything can burn
  const token = String(formData.get("token") ?? "");
  const jar = await cookies();
  const hdrs = await headers();
  const result = await redeemLoginCore(token, {
    existingCookie: jar.get(SESSION_COOKIE)?.value,
    requestHost: hdrs.get("host") ?? undefined,
    secret,
  });
  if (!result.ok) redirect("/login?error=invalid");
  jar.set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  redirect("/");
}
