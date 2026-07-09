import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionPayload = { businessId: string; email: string; exp: number };

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

function requireSecret(secret: string): void {
  if (!secret) throw new Error("Session secret is required (COCKPIT_SESSION_SECRET).");
}

export function createSessionToken(payload: SessionPayload, secret: string): string {
  requireSecret(secret);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body, secret).toString("base64url")}`;
}

export function verifySessionToken(token: string, secret: string, now: number = Date.now()): SessionPayload | null {
  requireSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = hmac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof parsed.businessId !== "string" || typeof parsed.email !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}
