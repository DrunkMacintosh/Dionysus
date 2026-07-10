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

  // Atomic churn accumulation — D22's headline metric. A JS read-modify-write
  // ((action.editDistance ?? 0) + distance, from the row read at function start) loses updates
  // under concurrent edits: two callers read the same base and the second write clobbers the
  // first's increment. Prisma's `{ increment }` is atomic (mirrors lifecycle.ts's
  // `rejectionCount: { increment: 1 }`), but `editDistance Int?` is NULLABLE and Prisma 6 /
  // SQLite treats `{ increment }` on a null column as a no-op (verified: null stays null). So we
  // first initialize null->0 (guarded by `editDistance: null`, scoped) — only the first edit
  // matches — then increment. Both writes scoped by (id, businessId).
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId, editDistance: null },
    data: { editDistance: 0 } });
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId },
    data: { editDistance: { increment: distance } } });

  // DB is now the source of truth for the cumulative total (not JS arithmetic on a stale read).
  const persisted = await prisma.routeAction.findFirst({
    where: { id: action.id, businessId: identity.businessId } });
  const totalEditDistance = persisted?.editDistance ?? distance;
  return { assetId, editDistance: distance, totalEditDistance };
}
