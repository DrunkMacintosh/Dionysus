import { createHash, randomBytes } from "node:crypto";
import { prisma } from "dionysus-mcp/db";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // H3: short-TTL

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueMagicLink(businessId: string, email: string): Promise<{ token: string; expiresAt: Date }> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new Error(`Business ${businessId} not found.`);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await prisma.magicLink.create({ data: { businessId, email, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

export async function verifyMagicLink(token: string): Promise<{ businessId: string; email: string }> {
  // H3 single-use: redemption is the atomic write — only an unused, unexpired row matches.
  // Mirrors dionysus-mcp's transitionOrThrow guarded-updateMany: a concurrent redemption
  // writes usedAt first and the loser matches zero rows, so it throws instead of double-redeeming.
  const { count } = await prisma.magicLink.updateMany({
    where: { tokenHash: hashToken(token), usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (count === 0) throw new Error("Magic link is invalid, expired, or already used.");
  const link = await prisma.magicLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link) throw new Error("Magic link row missing after redemption.");
  return { businessId: link.businessId, email: link.email };
}
