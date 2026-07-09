import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { hashContent } from "../lib/content-hash.js";

export type AssetInput = { channel: string; kind: string; content: unknown; routeActionId?: string };

export async function persistAsset(identity: Identity, input: AssetInput): Promise<{ assetId: string }> {
  if (input.routeActionId) {
    const action = await prisma.routeAction.findFirst({ where: { id: input.routeActionId, businessId: identity.businessId } });
    if (!action) throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  }
  const row = await prisma.asset.create({ data: {
    businessId: identity.businessId, channel: input.channel, kind: input.kind,
    contentJson: JSON.stringify(input.content ?? {}),
    routeActionId: input.routeActionId ?? null } });
  return { assetId: row.id };
}

export async function setActionAsset(identity: Identity, routeActionId: string, assetId: string): Promise<void> {
  const action = await prisma.routeAction.findFirst({ where: { id: routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${routeActionId} not found in this business scope.`);
  const asset = await prisma.asset.findFirst({ where: { id: assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${assetId} not found in this business scope.`);
  // Binding only in the drafting phase — an approved action's hash must never move (D29).
  const { count } = await prisma.routeAction.updateMany({
    where: { id: routeActionId, businessId: identity.businessId, status: "proposed" },
    data: { assetId, contentHash: hashContent(asset.contentJson) },
  });
  if (count === 0) {
    throw new Error(`Cannot bind asset: RouteAction ${routeActionId} is not in "proposed" status (binding is a drafting-phase act).`);
  }
}
