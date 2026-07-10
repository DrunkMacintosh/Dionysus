import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { levenshtein } from "../lib/edit-distance.js";
import { persistAsset, setActionAsset } from "./asset.js";

export type EditDraftInput = { routeActionId: string; newBody: string };
export type EditDraftResult = { assetId: string; editDistance: number; totalEditDistance: number };

/**
 * D22: a founder edit during review. Drafting-phase only (proposed) — the setActionAsset
 * bind-guard is the write-layer backstop; this pre-check just gives the friendly error.
 * Cumulative editDistance is the churn leading indicator.
 */
export async function editDraftContent(identity: Identity, input: EditDraftInput): Promise<EditDraftResult> {
  const action = await prisma.routeAction.findFirst({ where: { id: input.routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  if (action.status !== "proposed") {
    throw new Error(`Cannot edit: RouteAction ${input.routeActionId} is not in "proposed" status (editing is a drafting-phase act).`);
  }
  if (!action.assetId) throw new Error(`RouteAction ${input.routeActionId} has no bound asset to edit.`);
  const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${action.assetId} not found in this business scope.`);

  let content: Record<string, unknown>;
  try {
    content = JSON.parse(asset.contentJson) as Record<string, unknown>;
  } catch {
    content = {};
  }
  const oldBody = typeof content.body === "string" ? content.body : "";
  const distance = levenshtein(oldBody, input.newBody);
  if (distance === 0) {
    return { assetId: asset.id, editDistance: 0, totalEditDistance: action.editDistance ?? 0 };
  }

  const { assetId } = await persistAsset(identity, {
    channel: asset.channel, kind: asset.kind,
    content: { ...content, body: input.newBody }, routeActionId: action.id });
  await setActionAsset(identity, action.id, assetId); // proposed-only guard + hash rebind live here
  const totalEditDistance = (action.editDistance ?? 0) + distance;
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId },
    data: { editDistance: totalEditDistance } });
  return { assetId, editDistance: distance, totalEditDistance };
}
