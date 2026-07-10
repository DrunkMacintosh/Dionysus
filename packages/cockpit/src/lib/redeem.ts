import { verifyMagicLink } from "./magic-link";
import { createSessionToken, verifySessionToken } from "./session";
import { SESSION_TTL_MS } from "./auth";

export type RedeemResult = { ok: true; sessionToken: string } | { ok: false };

/**
 * H3 + CSRF posture (4a debt): redemption is a POST-only act. Refusal order matters —
 * host check, then live-session refusal, then (and only then) the single-use redemption,
 * so no refusal ever burns the founder's link.
 */
export async function redeemLoginCore(
  token: string,
  opts: { existingCookie?: string; requestHost?: string; secret: string; now?: number },
): Promise<RedeemResult> {
  const baseUrl = process.env.COCKPIT_BASE_URL;
  if (baseUrl && opts.requestHost && new URL(baseUrl).host !== opts.requestHost) return { ok: false };
  if (opts.existingCookie && verifySessionToken(opts.existingCookie, opts.secret, opts.now) !== null) {
    return { ok: false }; // a live session must never be silently replaced by a link
  }
  try {
    const { businessId, email } = await verifyMagicLink(token);
    const sessionToken = createSessionToken(
      { businessId, email, exp: (opts.now ?? Date.now()) + SESSION_TTL_MS }, opts.secret);
    return { ok: true, sessionToken };
  } catch {
    return { ok: false }; // uniform — no cause disclosure
  }
}
