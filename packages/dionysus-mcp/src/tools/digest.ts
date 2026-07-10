import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** D22: idempotent daily batch. digestId = the digest an action was FIRST batched into (never moves). */
export async function buildDailyDigest(identity: Identity, date: string = utcDayKey()): Promise<{ digestId: string; itemCount: number }> {
  const digest = await prisma.digest.upsert({
    where: { businessId_date: { businessId: identity.businessId, date } },
    create: { businessId: identity.businessId, date },
    update: {},
  });
  await prisma.routeAction.updateMany({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null }, digestId: null },
    data: { digestId: digest.id },
  });
  const itemCount = await prisma.routeAction.count({
    where: { businessId: identity.businessId, digestId: digest.id } });
  await prisma.digest.updateMany({
    where: { id: digest.id, businessId: identity.businessId }, data: { itemCount } });
  return { digestId: digest.id, itemCount };
}

export async function markDigestReviewed(identity: Identity, digestId: string): Promise<void> {
  const { count } = await prisma.digest.updateMany({
    where: { id: digestId, businessId: identity.businessId, reviewedAt: null },
    data: { reviewedAt: new Date() },
  });
  if (count === 0) throw new Error(`Digest ${digestId} not found in this business scope or already reviewed.`);
}
